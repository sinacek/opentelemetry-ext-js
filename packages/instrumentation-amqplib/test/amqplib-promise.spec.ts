import 'mocha';
import expect from 'expect';
import sinon from 'sinon';
import lodash from 'lodash';
import { AmqplibInstrumentation, EndOperation, PublishParams } from '../src';
import { getTestSpans, registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';

const instrumentation = registerInstrumentationTesting(new AmqplibInstrumentation());

import amqp, { ConsumeMessage } from 'amqplib';
import { MessagingDestinationKindValues, SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { asyncConfirmPublish, asyncConfirmSend, asyncConsume } from './utils';
import { TEST_RABBITMQ_HOST, TEST_RABBITMQ_PASS, TEST_RABBITMQ_PORT, TEST_RABBITMQ_USER } from './config';

const msgPayload = 'payload from test';
const queueName = 'queue-name-from-unittest';

// signal that the channel is closed in test, thus it should not be closed again in afterEach.
// could not find a way to get this from amqplib directly.
const CHANNEL_CLOSED_IN_TEST = Symbol('opentelemetry.amqplib.unittest.channel_closed_in_test');

describe('amqplib instrumentation promise model', function () {
    const url = `amqp://${TEST_RABBITMQ_USER}:${TEST_RABBITMQ_PASS}@${TEST_RABBITMQ_HOST}:${TEST_RABBITMQ_PORT}`;
    const censoredUrl = `amqp://${TEST_RABBITMQ_USER}:***@${TEST_RABBITMQ_HOST}:${TEST_RABBITMQ_PORT}`;
    let conn: amqp.Connection;
    before(async () => {
        conn = await amqp.connect(url);
    });
    after(async () => {
        await conn.close();
    });

    let endHookSpy;
    const expectConsumeEndSpyStatus = (expectedEndOperations: EndOperation[]): void => {
        expect(endHookSpy.callCount).toBe(expectedEndOperations.length);
        expectedEndOperations.forEach((endOperation: EndOperation, index: number) => {
            expect(endHookSpy.args[index][3]).toEqual(endOperation);
            switch (endOperation) {
                case EndOperation.AutoAck:
                case EndOperation.Ack:
                case EndOperation.AckAll:
                    expect(endHookSpy.args[index][2]).toBeFalsy();
                    break;

                case EndOperation.Reject:
                case EndOperation.Nack:
                case EndOperation.NackAll:
                case EndOperation.ChannelClosed:
                case EndOperation.ChannelError:
                    expect(endHookSpy.args[index][2]).toBeTruthy();
                    break;
            }
        });
    };

    describe('channel', () => {
        let channel: amqp.Channel;
        beforeEach(async () => {
            endHookSpy = sinon.spy();
            instrumentation.setConfig({
                consumeEndHook: endHookSpy,
            });

            channel = await conn.createChannel();
            await channel.assertQueue(queueName, { durable: false });
            await channel.purgeQueue(queueName);
            // install an error handler, otherwise when we have tests that create error on the channel,
            // it throws and crash process
            channel.on('error', (err) => {});
        });
        afterEach(async () => {
            if (!channel[CHANNEL_CLOSED_IN_TEST]) {
                try {
                    await new Promise<void>((resolve) => {
                        channel.on('close', resolve);
                        channel.close();
                    });
                } catch {}
            }
        });

        it('simple publish and consume from queue', async () => {
            const hadSpaceInBuffer = channel.sendToQueue(queueName, Buffer.from(msgPayload));
            expect(hadSpaceInBuffer).toBeTruthy();

            await asyncConsume(channel, queueName, [(msg) => expect(msg.content.toString()).toEqual(msgPayload)], {
                noAck: true,
            });
            const [publishSpan, consumeSpan] = getTestSpans();

            // assert publish span
            expect(publishSpan.kind).toEqual(SpanKind.PRODUCER);
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_SYSTEM]).toEqual('rabbitmq');
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION]).toEqual(''); // according to spec: "This will be an empty string if the default exchange is used"
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION_KIND]).toEqual(
                MessagingDestinationKindValues.TOPIC
            );
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_RABBITMQ_ROUTING_KEY]).toEqual(queueName);
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL]).toEqual('AMQP');
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL_VERSION]).toEqual('0.9.1');
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_URL]).toEqual(censoredUrl);
            expect(publishSpan.attributes[SemanticAttributes.NET_PEER_NAME]).toEqual(TEST_RABBITMQ_HOST);
            expect(publishSpan.attributes[SemanticAttributes.NET_PEER_PORT]).toEqual(TEST_RABBITMQ_PORT);

            // assert consume span
            expect(consumeSpan.kind).toEqual(SpanKind.CONSUMER);
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_SYSTEM]).toEqual('rabbitmq');
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION]).toEqual(''); // according to spec: "This will be an empty string if the default exchange is used"
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION_KIND]).toEqual(
                MessagingDestinationKindValues.TOPIC
            );
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_RABBITMQ_ROUTING_KEY]).toEqual(queueName);
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL]).toEqual('AMQP');
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL_VERSION]).toEqual('0.9.1');
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_URL]).toEqual(censoredUrl);
            expect(consumeSpan.attributes[SemanticAttributes.NET_PEER_NAME]).toEqual(TEST_RABBITMQ_HOST);
            expect(consumeSpan.attributes[SemanticAttributes.NET_PEER_PORT]).toEqual(TEST_RABBITMQ_PORT);

            // assert context propagation
            expect(consumeSpan.spanContext().traceId).toEqual(publishSpan.spanContext().traceId);
            expect(consumeSpan.parentSpanId).toEqual(publishSpan.spanContext().spanId);

            expectConsumeEndSpyStatus([EndOperation.AutoAck]);
        });

        describe('ending consume spans', () => {
            it('message acked sync', async () => {
                channel.sendToQueue(queueName, Buffer.from(msgPayload));

                await asyncConsume(channel, queueName, [(msg) => channel.ack(msg)]);
                // assert consumed message span has ended
                expect(getTestSpans().length).toBe(2);
                expectConsumeEndSpyStatus([EndOperation.Ack]);
            });

            it('message acked async', async () => {
                channel.sendToQueue(queueName, Buffer.from(msgPayload));

                // start async timer and ack the message after the callback returns
                await new Promise<void>((resolve) => {
                    asyncConsume(channel, queueName, [
                        (msg) =>
                            setTimeout(() => {
                                channel.ack(msg);
                                resolve();
                            }, 1),
                    ]);
                });
                // assert consumed message span has ended
                expect(getTestSpans().length).toBe(2);
                expectConsumeEndSpyStatus([EndOperation.Ack]);
            });

            it('message nack no requeue', async () => {
                channel.sendToQueue(queueName, Buffer.from(msgPayload));

                await asyncConsume(channel, queueName, [(msg) => channel.nack(msg, false, false)]);
                await new Promise((resolve) => setTimeout(resolve, 20)); // just make sure we don't get it again
                // assert consumed message span has ended
                expect(getTestSpans().length).toBe(2);
                const [_, consumerSpan] = getTestSpans();
                expect(consumerSpan.status.code).toEqual(SpanStatusCode.ERROR);
                expect(consumerSpan.status.message).toEqual('nack called on message without requeue');
                expectConsumeEndSpyStatus([EndOperation.Nack]);
            });

            it('message nack requeue, then acked', async () => {
                channel.sendToQueue(queueName, Buffer.from(msgPayload));

                // @ts-ignore
                await asyncConsume(channel, queueName, [
                    (msg: amqp.Message) => channel.nack(msg, false, true),
                    (msg: amqp.Message) => channel.ack(msg),
                ]);
                // assert we have the requeued message sent again
                expect(getTestSpans().length).toBe(3);
                const [_, rejectedConsumerSpan, successConsumerSpan] = getTestSpans();
                expect(rejectedConsumerSpan.status.code).toEqual(SpanStatusCode.ERROR);
                expect(rejectedConsumerSpan.status.message).toEqual('nack called on message with requeue');
                expect(successConsumerSpan.status.code).toEqual(SpanStatusCode.UNSET);
                expectConsumeEndSpyStatus([EndOperation.Nack, EndOperation.Ack]);
            });

            it('ack allUpTo 2 msgs sync', async () => {
                lodash.times(3, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                // @ts-ignore
                await asyncConsume(channel, queueName, [
                    null,
                    (msg) => channel.ack(msg, true),
                    (msg) => channel.ack(msg),
                ]);
                // assert all 3 messages are acked, including the first one which is acked by allUpTo
                expect(getTestSpans().length).toBe(6);
                expectConsumeEndSpyStatus([EndOperation.Ack, EndOperation.Ack, EndOperation.Ack]);
            });

            it('nack allUpTo 2 msgs sync', async () => {
                lodash.times(3, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                // @ts-ignore
                await asyncConsume(channel, queueName, [
                    null,
                    (msg) => channel.nack(msg, true, false),
                    (msg) => channel.nack(msg, false, false),
                ]);
                // assert all 3 messages are acked, including the first one which is acked by allUpTo
                expect(getTestSpans().length).toBe(6);
                lodash.range(3, 6).forEach((i) => {
                    expect(getTestSpans()[i].status.code).toEqual(SpanStatusCode.ERROR);
                    expect(getTestSpans()[i].status.message).toEqual('nack called on message without requeue');
                });
                expectConsumeEndSpyStatus([EndOperation.Nack, EndOperation.Nack, EndOperation.Nack]);
            });

            it('ack not in received order', async () => {
                lodash.times(3, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                // @ts-ignore
                const msgs = await asyncConsume(channel, queueName, [null, null, null]);
                channel.ack(msgs[1]);
                channel.ack(msgs[2]);
                channel.ack(msgs[0]);
                // assert all 3 span messages are ended
                expect(getTestSpans().length).toBe(6);
                expectConsumeEndSpyStatus([EndOperation.Ack, EndOperation.Ack, EndOperation.Ack]);
            });

            it('ackAll', async () => {
                lodash.times(2, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                // @ts-ignore
                await asyncConsume(channel, queueName, [null, () => channel.ackAll()]);
                // assert all 2 span messages are ended by call to ackAll
                expect(getTestSpans().length).toBe(4);
                expectConsumeEndSpyStatus([EndOperation.AckAll, EndOperation.AckAll]);
            });

            it('nackAll', async () => {
                lodash.times(2, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                // @ts-ignore
                await asyncConsume(channel, queueName, [null, () => channel.nackAll(false)]);
                // assert all 2 span messages are ended by calling nackAll
                expect(getTestSpans().length).toBe(4);
                lodash.range(2, 4).forEach((i) => {
                    expect(getTestSpans()[i].status.code).toEqual(SpanStatusCode.ERROR);
                    expect(getTestSpans()[i].status.message).toEqual('nackAll called on message without requeue');
                });
                expectConsumeEndSpyStatus([EndOperation.NackAll, EndOperation.NackAll]);
            });

            it('reject', async () => {
                lodash.times(1, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                // @ts-ignore
                await asyncConsume(channel, queueName, [(msg) => channel.reject(msg, false)]);
                expect(getTestSpans().length).toBe(2);
                expect(getTestSpans()[1].status.code).toEqual(SpanStatusCode.ERROR);
                expect(getTestSpans()[1].status.message).toEqual('reject called on message without requeue');
                expectConsumeEndSpyStatus([EndOperation.Reject]);
            });

            it('reject with requeue', async () => {
                lodash.times(1, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                // @ts-ignore
                await asyncConsume(channel, queueName, [
                    (msg) => channel.reject(msg, true),
                    (msg) => channel.reject(msg, false),
                ]);
                expect(getTestSpans().length).toBe(3);
                expect(getTestSpans()[1].status.code).toEqual(SpanStatusCode.ERROR);
                expect(getTestSpans()[1].status.message).toEqual('reject called on message with requeue');
                expect(getTestSpans()[2].status.code).toEqual(SpanStatusCode.ERROR);
                expect(getTestSpans()[2].status.message).toEqual('reject called on message without requeue');
                expectConsumeEndSpyStatus([EndOperation.Reject, EndOperation.Reject]);
            });

            it('closing channel should end all open spans on it', async () => {
                lodash.times(1, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                await new Promise<void>((resolve) =>
                    asyncConsume(channel, queueName, [
                        async (msg) => {
                            await channel.close();
                            resolve();
                            channel[CHANNEL_CLOSED_IN_TEST] = true;
                        },
                    ])
                );

                expect(getTestSpans().length).toBe(2);
                expect(getTestSpans()[1].status.code).toEqual(SpanStatusCode.ERROR);
                expect(getTestSpans()[1].status.message).toEqual('channel closed');
                expectConsumeEndSpyStatus([EndOperation.ChannelClosed]);
            });

            it('error on channel should end all open spans on it', (done) => {
                lodash.times(2, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                channel.on('close', () => {
                    expect(getTestSpans().length).toBe(4);
                    // second consume ended with valid ack, previous message not acked when channel is errored.
                    // since we first ack the second message, it appear first in the finished spans array
                    expect(getTestSpans()[2].status.code).toEqual(SpanStatusCode.UNSET);
                    expect(getTestSpans()[3].status.code).toEqual(SpanStatusCode.ERROR);
                    expect(getTestSpans()[3].status.message).toEqual('channel error');
                    expectConsumeEndSpyStatus([EndOperation.Ack, EndOperation.ChannelError]);
                    done();
                });
                asyncConsume(channel, queueName, [
                    null,
                    (msg) => {
                        try {
                            channel.ack(msg);
                            channel[CHANNEL_CLOSED_IN_TEST] = true;
                            // ack the same msg again, this is not valid and should close the channel
                            channel.ack(msg);
                        } catch {}
                    },
                ]);
            });

            it('not acking the message trigger timeout', async () => {
                instrumentation.setConfig({
                    consumeEndHook: endHookSpy,
                    consumeTimeoutMs: 1,
                });

                lodash.times(1, () => channel.sendToQueue(queueName, Buffer.from(msgPayload)));

                await asyncConsume(channel, queueName, [null]);

                // we have timeout of 1 ms, so we wait more than that and check span indeed ended
                await new Promise((resolve) => setTimeout(resolve, 10));

                expect(getTestSpans().length).toBe(2);
                expectConsumeEndSpyStatus([EndOperation.InstrumentationTimeout]);
            });
        });

        describe('routing and exchange', () => {
            it('topic exchange', async () => {
                const exchangeName = 'topic exchange';
                const routingKey = 'topic.name.from.unittest';
                await channel.assertExchange(exchangeName, 'topic', { durable: false });

                const { queue: queueName } = await channel.assertQueue('', { durable: false });
                await channel.bindQueue(queueName, exchangeName, '#');

                channel.publish(exchangeName, routingKey, Buffer.from(msgPayload));

                await asyncConsume(channel, queueName, [null], {
                    noAck: true,
                });

                const [publishSpan, consumeSpan] = getTestSpans();

                // assert publish span
                expect(publishSpan.kind).toEqual(SpanKind.PRODUCER);
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_SYSTEM]).toEqual('rabbitmq');
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION]).toEqual(exchangeName);
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION_KIND]).toEqual(
                    MessagingDestinationKindValues.TOPIC
                );
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_RABBITMQ_ROUTING_KEY]).toEqual(routingKey);
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL]).toEqual('AMQP');
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL_VERSION]).toEqual('0.9.1');

                // assert consume span
                expect(consumeSpan.kind).toEqual(SpanKind.CONSUMER);
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_SYSTEM]).toEqual('rabbitmq');
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION]).toEqual(exchangeName);
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION_KIND]).toEqual(
                    MessagingDestinationKindValues.TOPIC
                );
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_RABBITMQ_ROUTING_KEY]).toEqual(routingKey);
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL]).toEqual('AMQP');
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL_VERSION]).toEqual('0.9.1');

                // assert context propagation
                expect(consumeSpan.spanContext().traceId).toEqual(publishSpan.spanContext().traceId);
                expect(consumeSpan.parentSpanId).toEqual(publishSpan.spanContext().spanId);
            });
        });

        it('moduleVersionAttributeName works with publish and consume', async () => {
            const VERSION_ATTR = 'module.version';
            instrumentation.setConfig({
                moduleVersionAttributeName: VERSION_ATTR,
            });

            channel.sendToQueue(queueName, Buffer.from(msgPayload));

            await asyncConsume(channel, queueName, [(msg) => expect(msg.content.toString()).toEqual(msgPayload)], {
                noAck: true,
            });
            expect(getTestSpans().length).toBe(2);
            getTestSpans().forEach((s) => expect(s.attributes[VERSION_ATTR]).toMatch(/\d{1,4}\.\d{1,4}\.\d{1,5}.*/));
        });

        describe('hooks', () => {
            it('publish and consume hooks success', async () => {
                const attributeNameFromHook = 'attribute.name.from.hook';
                const hookAttributeValue = 'attribute value from hook';
                const attributeNameFromEndHook = 'attribute.name.from.endhook';
                const endHookAttributeValue = 'attribute value from end hook';
                instrumentation.setConfig({
                    publishHook: (span: Span, publishParams: PublishParams): void => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        expect(publishParams.exchange).toEqual('');
                        expect(publishParams.routingKey).toEqual(queueName);
                        expect(publishParams.content.toString()).toEqual(msgPayload);
                    },
                    consumeHook: (span: Span, msg: amqp.ConsumeMessage | null): void => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        expect(msg.content.toString()).toEqual(msgPayload);
                    },
                    consumeEndHook: (
                        span: Span,
                        msg: amqp.ConsumeMessage | null,
                        rejected: boolean,
                        endOperation: EndOperation
                    ): void => {
                        span.setAttribute(attributeNameFromEndHook, endHookAttributeValue);
                        expect(endOperation).toEqual(EndOperation.AutoAck);
                    },
                });

                channel.sendToQueue(queueName, Buffer.from(msgPayload));

                await asyncConsume(channel, queueName, [null], {
                    noAck: true,
                });
                expect(getTestSpans().length).toBe(2);
                expect(getTestSpans()[0].attributes[attributeNameFromHook]).toEqual(hookAttributeValue);
                expect(getTestSpans()[1].attributes[attributeNameFromHook]).toEqual(hookAttributeValue);
                expect(getTestSpans()[1].attributes[attributeNameFromEndHook]).toEqual(endHookAttributeValue);
            });

            it('hooks throw should not affect user flow or span creation', async () => {
                const attributeNameFromHook = 'attribute.name.from.hook';
                const hookAttributeValue = 'attribute value from hook';
                instrumentation.setConfig({
                    publishHook: (span: Span, publishParams: PublishParams): void => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        throw new Error('error from hook');
                    },
                    consumeHook: (span: Span, msg: amqp.ConsumeMessage | null): void => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        throw new Error('error from hook');
                    },
                });

                channel.sendToQueue(queueName, Buffer.from(msgPayload));

                await asyncConsume(channel, queueName, [null], {
                    noAck: true,
                });
                expect(getTestSpans().length).toBe(2);
                getTestSpans().forEach((s) => expect(s.attributes[attributeNameFromHook]).toEqual(hookAttributeValue));
            });
        });

        describe('delete queue', () => {
            it('consumer receives null msg when a queue is deleted in broker', async () => {
                const queueNameForDeletion = 'queue-to-be-deleted';
                await channel.assertQueue(queueNameForDeletion, { durable: false });
                await channel.purgeQueue(queueNameForDeletion);

                await channel.consume(queueNameForDeletion, (msg: ConsumeMessage | null) => {}, { noAck: true });
                await channel.deleteQueue(queueNameForDeletion);
            });
        });
    });

    describe('confirm channel', () => {
        let confirmChannel: amqp.ConfirmChannel;
        beforeEach(async () => {
            endHookSpy = sinon.spy();
            instrumentation.setConfig({
                consumeEndHook: endHookSpy,
            });

            confirmChannel = await conn.createConfirmChannel();
            await confirmChannel.assertQueue(queueName, { durable: false });
            await confirmChannel.purgeQueue(queueName);
            // install an error handler, otherwise when we have tests that create error on the channel,
            // it throws and crash process
            confirmChannel.on('error', (err) => {});
        });
        afterEach(async () => {
            if (!confirmChannel[CHANNEL_CLOSED_IN_TEST]) {
                try {
                    await new Promise<void>((resolve) => {
                        confirmChannel.on('close', resolve);
                        confirmChannel.close();
                    });
                } catch {}
            }
        });

        it('simple publish with confirm and consume from queue', async () => {
            await asyncConfirmSend(confirmChannel, queueName, msgPayload);

            await asyncConsume(
                confirmChannel,
                queueName,
                [(msg) => expect(msg.content.toString()).toEqual(msgPayload)],
                {
                    noAck: true,
                }
            );
            const [publishSpan, consumeSpan] = getTestSpans();

            // assert publish span
            expect(publishSpan.kind).toEqual(SpanKind.PRODUCER);
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_SYSTEM]).toEqual('rabbitmq');
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION]).toEqual(''); // according to spec: "This will be an empty string if the default exchange is used"
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION_KIND]).toEqual(
                MessagingDestinationKindValues.TOPIC
            );
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_RABBITMQ_ROUTING_KEY]).toEqual(queueName);
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL]).toEqual('AMQP');
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL_VERSION]).toEqual('0.9.1');
            expect(publishSpan.attributes[SemanticAttributes.MESSAGING_URL]).toEqual(censoredUrl);
            expect(publishSpan.attributes[SemanticAttributes.NET_PEER_NAME]).toEqual(TEST_RABBITMQ_HOST);
            expect(publishSpan.attributes[SemanticAttributes.NET_PEER_PORT]).toEqual(TEST_RABBITMQ_PORT);

            // assert consume span
            expect(consumeSpan.kind).toEqual(SpanKind.CONSUMER);
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_SYSTEM]).toEqual('rabbitmq');
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION]).toEqual(''); // according to spec: "This will be an empty string if the default exchange is used"
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION_KIND]).toEqual(
                MessagingDestinationKindValues.TOPIC
            );
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_RABBITMQ_ROUTING_KEY]).toEqual(queueName);
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL]).toEqual('AMQP');
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL_VERSION]).toEqual('0.9.1');
            expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_URL]).toEqual(censoredUrl);
            expect(consumeSpan.attributes[SemanticAttributes.NET_PEER_NAME]).toEqual(TEST_RABBITMQ_HOST);
            expect(consumeSpan.attributes[SemanticAttributes.NET_PEER_PORT]).toEqual(TEST_RABBITMQ_PORT);

            // assert context propagation
            expect(consumeSpan.spanContext().traceId).toEqual(publishSpan.spanContext().traceId);

            expectConsumeEndSpyStatus([EndOperation.AutoAck]);
        });

        it('confirm throw should not affect span end', async () => {
            const confirmUserError = new Error('callback error');
            await asyncConfirmSend(confirmChannel, queueName, msgPayload, () => {
                throw confirmUserError;
            }).catch((reject) => expect(reject).toEqual(confirmUserError));

            await asyncConsume(
                confirmChannel,
                queueName,
                [(msg) => expect(msg.content.toString()).toEqual(msgPayload)],
                {
                    noAck: true,
                }
            );

            expect(getTestSpans()).toHaveLength(2);
            expectConsumeEndSpyStatus([EndOperation.AutoAck]);
        });

        describe('ending consume spans', () => {
            it('message acked sync', async () => {
                await asyncConfirmSend(confirmChannel, queueName, msgPayload);

                await asyncConsume(confirmChannel, queueName, [(msg) => confirmChannel.ack(msg)]);
                // assert consumed message span has ended
                expect(getTestSpans().length).toBe(2);
                expectConsumeEndSpyStatus([EndOperation.Ack]);
            });

            it('message acked async', async () => {
                await asyncConfirmSend(confirmChannel, queueName, msgPayload);

                // start async timer and ack the message after the callback returns
                await new Promise<void>((resolve) => {
                    asyncConsume(confirmChannel, queueName, [
                        (msg) =>
                            setTimeout(() => {
                                confirmChannel.ack(msg);
                                resolve();
                            }, 1),
                    ]);
                });
                // assert consumed message span has ended
                expect(getTestSpans().length).toBe(2);
                expectConsumeEndSpyStatus([EndOperation.Ack]);
            });

            it('message nack no requeue', async () => {
                await asyncConfirmSend(confirmChannel, queueName, msgPayload);

                await asyncConsume(confirmChannel, queueName, [(msg) => confirmChannel.nack(msg, false, false)]);
                await new Promise((resolve) => setTimeout(resolve, 20)); // just make sure we don't get it again
                // assert consumed message span has ended
                expect(getTestSpans().length).toBe(2);
                const [_, consumerSpan] = getTestSpans();
                expect(consumerSpan.status.code).toEqual(SpanStatusCode.ERROR);
                expect(consumerSpan.status.message).toEqual('nack called on message without requeue');
                expectConsumeEndSpyStatus([EndOperation.Nack]);
            });

            it('message nack requeue, then acked', async () => {
                await asyncConfirmSend(confirmChannel, queueName, msgPayload);

                // @ts-ignore
                await asyncConsume(confirmChannel, queueName, [
                    (msg: amqp.Message) => confirmChannel.nack(msg, false, true),
                    (msg: amqp.Message) => confirmChannel.ack(msg),
                ]);
                // assert we have the requeued message sent again
                expect(getTestSpans().length).toBe(3);
                const [_, rejectedConsumerSpan, successConsumerSpan] = getTestSpans();
                expect(rejectedConsumerSpan.status.code).toEqual(SpanStatusCode.ERROR);
                expect(rejectedConsumerSpan.status.message).toEqual('nack called on message with requeue');
                expect(successConsumerSpan.status.code).toEqual(SpanStatusCode.UNSET);
                expectConsumeEndSpyStatus([EndOperation.Nack, EndOperation.Ack]);
            });

            it('ack allUpTo 2 msgs sync', async () => {
                await Promise.all(lodash.times(3, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                // @ts-ignore
                await asyncConsume(confirmChannel, queueName, [
                    null,
                    (msg) => confirmChannel.ack(msg, true),
                    (msg) => confirmChannel.ack(msg),
                ]);
                // assert all 3 messages are acked, including the first one which is acked by allUpTo
                expect(getTestSpans().length).toBe(6);
                expectConsumeEndSpyStatus([EndOperation.Ack, EndOperation.Ack, EndOperation.Ack]);
            });

            it('nack allUpTo 2 msgs sync', async () => {
                await Promise.all(lodash.times(3, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                // @ts-ignore
                await asyncConsume(confirmChannel, queueName, [
                    null,
                    (msg) => confirmChannel.nack(msg, true, false),
                    (msg) => confirmChannel.nack(msg, false, false),
                ]);
                // assert all 3 messages are acked, including the first one which is acked by allUpTo
                expect(getTestSpans().length).toBe(6);
                lodash.range(3, 6).forEach((i) => {
                    expect(getTestSpans()[i].status.code).toEqual(SpanStatusCode.ERROR);
                    expect(getTestSpans()[i].status.message).toEqual('nack called on message without requeue');
                });
                expectConsumeEndSpyStatus([EndOperation.Nack, EndOperation.Nack, EndOperation.Nack]);
            });

            it('ack not in received order', async () => {
                await Promise.all(lodash.times(3, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                // @ts-ignore
                const msgs = await asyncConsume(confirmChannel, queueName, [null, null, null]);
                confirmChannel.ack(msgs[1]);
                confirmChannel.ack(msgs[2]);
                confirmChannel.ack(msgs[0]);
                // assert all 3 span messages are ended
                expect(getTestSpans().length).toBe(6);
                expectConsumeEndSpyStatus([EndOperation.Ack, EndOperation.Ack, EndOperation.Ack]);
            });

            it('ackAll', async () => {
                await Promise.all(lodash.times(2, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                // @ts-ignore
                await asyncConsume(confirmChannel, queueName, [null, () => confirmChannel.ackAll()]);
                // assert all 2 span messages are ended by call to ackAll
                expect(getTestSpans().length).toBe(4);
                expectConsumeEndSpyStatus([EndOperation.AckAll, EndOperation.AckAll]);
            });

            it('nackAll', async () => {
                await Promise.all(lodash.times(2, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                // @ts-ignore
                await asyncConsume(confirmChannel, queueName, [null, () => confirmChannel.nackAll(false)]);
                // assert all 2 span messages are ended by calling nackAll
                expect(getTestSpans().length).toBe(4);
                lodash.range(2, 4).forEach((i) => {
                    expect(getTestSpans()[i].status.code).toEqual(SpanStatusCode.ERROR);
                    expect(getTestSpans()[i].status.message).toEqual('nackAll called on message without requeue');
                });
                expectConsumeEndSpyStatus([EndOperation.NackAll, EndOperation.NackAll]);
            });

            it('reject', async () => {
                await Promise.all(lodash.times(1, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                // @ts-ignore
                await asyncConsume(confirmChannel, queueName, [(msg) => confirmChannel.reject(msg, false)]);
                expect(getTestSpans().length).toBe(2);
                expect(getTestSpans()[1].status.code).toEqual(SpanStatusCode.ERROR);
                expect(getTestSpans()[1].status.message).toEqual('reject called on message without requeue');
                expectConsumeEndSpyStatus([EndOperation.Reject]);
            });

            it('reject with requeue', async () => {
                await Promise.all(lodash.times(1, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                // @ts-ignore
                await asyncConsume(confirmChannel, queueName, [
                    (msg) => confirmChannel.reject(msg, true),
                    (msg) => confirmChannel.reject(msg, false),
                ]);
                expect(getTestSpans().length).toBe(3);
                expect(getTestSpans()[1].status.code).toEqual(SpanStatusCode.ERROR);
                expect(getTestSpans()[1].status.message).toEqual('reject called on message with requeue');
                expect(getTestSpans()[2].status.code).toEqual(SpanStatusCode.ERROR);
                expect(getTestSpans()[2].status.message).toEqual('reject called on message without requeue');
                expectConsumeEndSpyStatus([EndOperation.Reject, EndOperation.Reject]);
            });

            it('closing channel should end all open spans on it', async () => {
                await Promise.all(lodash.times(1, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                await new Promise<void>((resolve) =>
                    asyncConsume(confirmChannel, queueName, [
                        async (msg) => {
                            await confirmChannel.close();
                            resolve();
                            confirmChannel[CHANNEL_CLOSED_IN_TEST] = true;
                        },
                    ])
                );

                expect(getTestSpans().length).toBe(2);
                expect(getTestSpans()[1].status.code).toEqual(SpanStatusCode.ERROR);
                expect(getTestSpans()[1].status.message).toEqual('channel closed');
                expectConsumeEndSpyStatus([EndOperation.ChannelClosed]);
            });

            it('error on channel should end all open spans on it', (done) => {
                Promise.all(lodash.times(2, () => asyncConfirmSend(confirmChannel, queueName, msgPayload))).then(() => {
                    confirmChannel.on('close', () => {
                        expect(getTestSpans().length).toBe(4);
                        // second consume ended with valid ack, previous message not acked when channel is errored.
                        // since we first ack the second message, it appear first in the finished spans array
                        expect(getTestSpans()[2].status.code).toEqual(SpanStatusCode.UNSET);
                        expect(getTestSpans()[3].status.code).toEqual(SpanStatusCode.ERROR);
                        expect(getTestSpans()[3].status.message).toEqual('channel error');
                        expectConsumeEndSpyStatus([EndOperation.Ack, EndOperation.ChannelError]);
                        done();
                    });
                    asyncConsume(confirmChannel, queueName, [
                        null,
                        (msg) => {
                            try {
                                confirmChannel.ack(msg);
                                confirmChannel[CHANNEL_CLOSED_IN_TEST] = true;
                                // ack the same msg again, this is not valid and should close the channel
                                confirmChannel.ack(msg);
                            } catch {}
                        },
                    ]);
                });
            });

            it('not acking the message trigger timeout', async () => {
                instrumentation.setConfig({
                    consumeEndHook: endHookSpy,
                    consumeTimeoutMs: 1,
                });

                await Promise.all(lodash.times(1, () => asyncConfirmSend(confirmChannel, queueName, msgPayload)));

                await asyncConsume(confirmChannel, queueName, [null]);

                // we have timeout of 1 ms, so we wait more than that and check span indeed ended
                await new Promise((resolve) => setTimeout(resolve, 10));

                expect(getTestSpans().length).toBe(2);
                expectConsumeEndSpyStatus([EndOperation.InstrumentationTimeout]);
            });
        });

        describe('routing and exchange', () => {
            it('topic exchange', async () => {
                const exchangeName = 'topic exchange';
                const routingKey = 'topic.name.from.unittest';
                await confirmChannel.assertExchange(exchangeName, 'topic', { durable: false });

                const { queue: queueName } = await confirmChannel.assertQueue('', { durable: false });
                await confirmChannel.bindQueue(queueName, exchangeName, '#');

                await asyncConfirmPublish(confirmChannel, exchangeName, routingKey, msgPayload);

                await asyncConsume(confirmChannel, queueName, [null], {
                    noAck: true,
                });

                const [publishSpan, consumeSpan] = getTestSpans();

                // assert publish span
                expect(publishSpan.kind).toEqual(SpanKind.PRODUCER);
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_SYSTEM]).toEqual('rabbitmq');
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION]).toEqual(exchangeName);
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION_KIND]).toEqual(
                    MessagingDestinationKindValues.TOPIC
                );
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_RABBITMQ_ROUTING_KEY]).toEqual(routingKey);
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL]).toEqual('AMQP');
                expect(publishSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL_VERSION]).toEqual('0.9.1');

                // assert consume span
                expect(consumeSpan.kind).toEqual(SpanKind.CONSUMER);
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_SYSTEM]).toEqual('rabbitmq');
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION]).toEqual(exchangeName);
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_DESTINATION_KIND]).toEqual(
                    MessagingDestinationKindValues.TOPIC
                );
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_RABBITMQ_ROUTING_KEY]).toEqual(routingKey);
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL]).toEqual('AMQP');
                expect(consumeSpan.attributes[SemanticAttributes.MESSAGING_PROTOCOL_VERSION]).toEqual('0.9.1');

                // assert context propagation
                expect(consumeSpan.spanContext().traceId).toEqual(publishSpan.spanContext().traceId);
                expect(consumeSpan.parentSpanId).toEqual(publishSpan.spanContext().spanId);
            });
        });

        it('moduleVersionAttributeName works with publish and consume', async () => {
            const VERSION_ATTR = 'module.version';
            instrumentation.setConfig({
                moduleVersionAttributeName: VERSION_ATTR,
            });

            await asyncConfirmSend(confirmChannel, queueName, msgPayload);

            await asyncConsume(
                confirmChannel,
                queueName,
                [(msg) => expect(msg.content.toString()).toEqual(msgPayload)],
                {
                    noAck: true,
                }
            );
            expect(getTestSpans().length).toBe(2);
            getTestSpans().forEach((s) => expect(s.attributes[VERSION_ATTR]).toMatch(/\d{1,4}\.\d{1,4}\.\d{1,5}.*/));
        });

        describe('hooks', () => {
            it('publish and consume hooks success', async () => {
                const attributeNameFromHook = 'attribute.name.from.hook';
                const hookAttributeValue = 'attribute value from hook';
                const attributeNameFromConfirmEndHook = 'attribute.name.from.confirm.endhook';
                const confirmEndHookAttributeValue = 'attribute value from confirm end hook';
                const attributeNameFromConsumeEndHook = 'attribute.name.from.consume.endhook';
                const consumeEndHookAttributeValue = 'attribute value from consume end hook';
                instrumentation.setConfig({
                    publishHook: (span: Span, publishParams: PublishParams) => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        expect(publishParams.exchange).toEqual('');
                        expect(publishParams.routingKey).toEqual(queueName);
                        expect(publishParams.content.toString()).toEqual(msgPayload);
                        expect(publishParams.isConfirmChannel).toBe(true);
                    },
                    publishConfirmHook: (span, publishParams) => {
                        span.setAttribute(attributeNameFromConfirmEndHook, confirmEndHookAttributeValue);
                        expect(publishParams.exchange).toEqual('');
                        expect(publishParams.routingKey).toEqual(queueName);
                        expect(publishParams.content.toString()).toEqual(msgPayload);
                    },
                    consumeHook: (span: Span, msg: amqp.ConsumeMessage | null) => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        expect(msg.content.toString()).toEqual(msgPayload);
                    },
                    consumeEndHook: (
                        span: Span,
                        msg: amqp.ConsumeMessage | null,
                        rejected: boolean,
                        endOperation: EndOperation
                    ): void => {
                        span.setAttribute(attributeNameFromConsumeEndHook, consumeEndHookAttributeValue);
                        expect(endOperation).toEqual(EndOperation.AutoAck);
                    },
                });

                await asyncConfirmSend(confirmChannel, queueName, msgPayload);

                await asyncConsume(confirmChannel, queueName, [null], {
                    noAck: true,
                });
                expect(getTestSpans().length).toBe(2);
                expect(getTestSpans()[0].attributes[attributeNameFromHook]).toEqual(hookAttributeValue);
                expect(getTestSpans()[0].attributes[attributeNameFromConfirmEndHook]).toEqual(
                    confirmEndHookAttributeValue
                );
                expect(getTestSpans()[1].attributes[attributeNameFromHook]).toEqual(hookAttributeValue);
                expect(getTestSpans()[1].attributes[attributeNameFromConsumeEndHook]).toEqual(
                    consumeEndHookAttributeValue
                );
            });

            it('hooks throw should not affect user flow or span creation', async () => {
                const attributeNameFromHook = 'attribute.name.from.hook';
                const hookAttributeValue = 'attribute value from hook';
                instrumentation.setConfig({
                    publishHook: (span: Span, publishParams: PublishParams): void => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        throw new Error('error from hook');
                    },
                    publishConfirmHook: (span: Span, publishParams: PublishParams): void => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        throw new Error('error from hook');
                    },
                    consumeHook: (span: Span, msg: amqp.ConsumeMessage | null): void => {
                        span.setAttribute(attributeNameFromHook, hookAttributeValue);
                        throw new Error('error from hook');
                    },
                });

                await asyncConfirmSend(confirmChannel, queueName, msgPayload);

                await asyncConsume(confirmChannel, queueName, [null], {
                    noAck: true,
                });
                expect(getTestSpans().length).toBe(2);
                getTestSpans().forEach((s) => expect(s.attributes[attributeNameFromHook]).toEqual(hookAttributeValue));
            });
        });
    });
});
