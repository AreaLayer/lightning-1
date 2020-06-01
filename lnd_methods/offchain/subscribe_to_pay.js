const {createHash} = require('crypto');
const EventEmitter = require('events');

const asyncAuto = require('async/auto');
const {chanFormat} = require('bolt07');
const {chanNumber} = require('bolt07');

const {confirmedFromPayment} = require('./../../lnd_responses');
const {confirmedFromPaymentStatus} = require('./../../lnd_responses');
const emitLegacyPayment = require('./emit_legacy_payment');
const emitPayment = require('./emit_payment');
const {failureFromPayment} = require('./../../lnd_responses');
const {getWalletInfo} = require('./../info');
const {isLnd} = require('./../../lnd_requests');
const {paymentAmounts} = require('./../../bolt00');
const {routeHintFromRoute} = require('./../../lnd_requests');
const {safeTokens} = require('./../../bolt00');
const {stateAsFailure} = require('./../../lnd_responses');
const {states} = require('./payment_states');

const cltvBuf = 3;
const cltvLimit = (limit, height) => !limit ? undefined : limit - height;
const defaultCltvDelta = 43;
const defaultTimeoutSeconds = 25;
const hexToBuf = hex => !hex ? undefined : Buffer.from(hex, 'hex');
const {isArray} = Array;
const isHex = n => !!n && !(n.length % 2) && /^[0-9A-F]*$/i.test(n);
const maxTokens = '4294967296';
const method = 'sendPaymentV2';
const msPerSec = 1000;
const mtokensPerToken = BigInt(1e3);
const {nextTick} = process;
const numberFromChannel = channel => chanNumber({channel}).number;
const {round} = Math;
const sha256 = preimage => createHash('sha256').update(preimage).digest();
const singleChanIdsCommitHash = '1a3194d302f33bb52823297d9d7f75cd37516053';
const type = 'router';
const unknownServiceErr = 'unknown service verrpc.Versioner';

/** Initiate and subscribe to the outcome of a payment

  LND built with `routerrpc` build tag is required

  Either a request or a destination, id, and tokens amount is required

  Failure due to invalid payment will only be registered on LND 0.7.1+

  Specifying `features` is not supported on LND 0.8.2 and below
  Specifying `incoming_peer` is not supported on LND 0.8.2 and below
  Specifying `messages` is not supported on LND 0.8.2 and below

  Specifying `max_paths` is not suppoorted on LND 0.9.2 and below

  Specifying `outgoing_channels` is not supported on LND 0.10.0 and below

  {
    [cltv_delta]: <Final CLTV Delta Number>
    [destination]: <Destination Public Key String>
    [features]: [{
      bit: <Feature Bit Number>
    }]
    [id]: <Payment Request Hash Hex String>
    [incoming_peer]: <Pay Through Specific Final Hop Public Key Hex String>
    lnd: <Authenticated LND gRPC API Object>
    [max_fee]: <Maximum Fee Tokens To Pay Number>
    [max_fee_mtokens]: <Maximum Fee Millitokens to Pay String>
    [max_paths]: <Maximum Simultaneous Paths Number>
    [max_timeout_height]: <Maximum Height of Payment Timeout Number>
    [messages]: [{
      type: <Message Type Number String>
      value: <Message Raw Value Hex Encoded String>
    }]
    [mtokens]: <Millitokens to Pay String>
    [outgoing_channel]: <Pay Out of Outgoing Channel Id String>
    [outgoing_channels]: [<Pay Out of Outgoing Channel Ids String>]
    [pathfinding_timeout]: <Time to Spend Finding a Route Milliseconds Number>
    [request]: <BOLT 11 Payment Request String>
    [routes]: [[{
      [base_fee_mtokens]: <Base Routing Fee In Millitokens String>
      [channel]: <Standard Format Channel Id String>
      [cltv_delta]: <CLTV Blocks Delta Number>
      [fee_rate]: <Fee Rate In Millitokens Per Million Number>
      public_key: <Forward Edge Public Key Hex String>
    }]]
    [tokens]: <Tokens to Probe Number>
  }

  @throws
  <Error>

  @returns
  <Subscription EventEmitter Object>

  @event 'confirmed'
  {
    fee: <Total Fee Tokens Paid Rounded Down Number>
    fee_mtokens: <Total Fee Millitokens Paid String>
    hops: [{
      channel: <First Route Standard Format Channel Id String>
      channel_capacity: <First Route Channel Capacity Tokens Number>
      fee: <First Route Fee Tokens Rounded Down Number>
      fee_mtokens: <First Route Fee Millitokens String>
      forward_mtokens: <First Route Forward Millitokens String>
      public_key: <First Route Public Key Hex String>
      timeout: <First Route Timeout Block Height Number>
    }]
    id: <Payment Hash Hex String>
    mtokens: <Total Millitokens Paid String>
    paths: [{
      fee_mtokens: <Total Fee Millitokens Paid String>
      hops: [{
        channel: <First Route Standard Format Channel Id String>
        channel_capacity: <First Route Channel Capacity Tokens Number>
        fee: <First Route Fee Tokens Rounded Down Number>
        fee_mtokens: <First Route Fee Millitokens String>
        forward_mtokens: <First Route Forward Millitokens String>
        public_key: <First Route Public Key Hex String>
        timeout: <First Route Timeout Block Height Number>
      }]
      mtokens: <Total Millitokens Paid String>
    }]
    safe_fee: <Total Fee Tokens Paid Rounded Up Number>
    safe_tokens: <Total Tokens Paid, Rounded Up Number>
    secret: <Payment Preimage Hex String>
    timeout: <Expiration Block Height Number>
    tokens: <Total Tokens Paid Rounded Down Number>
  }

  @event 'failed'
  {
    is_insufficient_balance: <Failed Due To Lack of Balance Bool>
    is_invalid_payment: <Failed Due to Invalid Payment Bool>
    is_pathfinding_timeout: <Failed Due to Pathfinding Timeout Bool>
    is_route_not_found: <Failed Due to Route Not Found Bool>
    [route]: {
      fee: <Route Total Fee Tokens Rounded Down Number>
      fee_mtokens: <Route Total Fee Millitokens String>
      hops: [{
        channel: <Standard Format Channel Id String>
        channel_capacity: <Channel Capacity Tokens Number>
        fee: <Hop Forwarding Fee Rounded Down Tokens Number>
        fee_mtokens: <Hop Forwarding Fee Millitokens String>
        forward: <Hop Forwarding Tokens Rounded Down Number>
        forward_mtokens: <Hop Forwarding Millitokens String>
        public_key: <Hop Sending To Public Key Hex String>
        timeout: <Hop CTLV Expiration Height Number>
      }]
      mtokens: <Payment Sending Millitokens String>
      safe_fee: <Payment Forwarding Fee Rounded Up Tokens Number>
      safe_tokens: <Payment Sending Tokens Rounded Up Number>
      timeout: <Payment CLTV Expiration Height Number>
      tokens: <Payment Sending Tokens Rounded Down Number>
    }
  }

  @event 'paying'
  {}
*/
module.exports = args => {
  if (!!args.cltv_delta && !!args.request) {
    throw new Error('UnexpectedCltvDeltaWhenSubscribingToPayPaymentRequest');
  }

  if (!args.destination && !args.request) {
    throw new Error('ExpectedDestinationWhenPaymentRequestNotSpecified');
  }

  if (!args.id && !args.request) {
    throw new Error('ExpectedPaymentHashWhenPaymentRequestNotSpecified');
  }

  if (!isLnd({method, type, lnd: args.lnd})) {
    throw new Error('ExpectedAuthenticatedLndToSubscribeToPayment');
  }

  if (!!args.messages && !isArray(args.messages)) {
    throw new Error('ExpectedArrayOfMessagesToSubscribeToPayment');
  }

  if (!!args.messages) {
    if (args.messages.length !== args.messages.filter(n => !!n).length) {
      throw new Error('ExpectedMessageEntriesInPaymentMessages');
    }

    if (!!args.messages.find(n => !n.type)) {
      throw new Error('ExpectedMessageTypeNumberInPaymentMessages');
    }

    if (!!args.messages.find(n => !isHex(n.value))) {
      throw new Error('ExpectedHexEncodedValuesInPaymentMessages');
    }
  }

  if (!args.mtokens && !args.tokens && !args.request) {
    throw new Error('ExpectedTokenAmountToPayWhenPaymentRequestNotSpecified');
  }

  if (!!args.routes && !isArray(args.routes)) {
    throw new Error('UnexpectedFormatForRoutesWhenSubscribingToPayment');
  }

  if (!!args.routes) {
    try {
      args.routes.forEach(route => routeHintFromRoute({route}));
    } catch (err) {
      throw new Error('ExpectedValidRoutesWhenSubscribingToPayment');
    }
  }

  const channel = !!args.outgoing_channel ? args.outgoing_channel : null;
  const emitter = new EventEmitter();
  const features = !args.features ? undefined : args.features.map(n => n.bit);
  const maxFee = args.max_fee !== undefined ? args.max_fee : maxTokens;
  const messages = args.messages || [];
  const routes = (args.routes || []);
  const timeoutSecs = round((args.pathfinding_timeout || Number()) / msPerSec);

  const emitError = err => {
    if (!emitter.listenerCount('error')) {
      return;
    }

    if (!!isArray(err)) {
      return emitter.emit('error', err);
    }

    return emitter.emit('error', [503, 'UnexpectedPaymentError', {err}]);
  };

  const hints = routes.map(route => {
    return {hop_hints: routeHintFromRoute({route}).hops};
  });

  const finalCltv = !args.cltv_delta ? defaultCltvDelta : args.cltv_delta;

  asyncAuto({
    // Determine the block height to figure out the height delta
    getHeight: cbk => {
      // Exit early when there is no max timeout restriction
      if (!args.max_timeout_height) {
        return cbk();
      }

      return getWalletInfo({lnd: args.lnd}, cbk);
    },

    // Determine the wallet version to support LND 0.9.2 and below
    getVersion: cbk => {
      return args.lnd.version.getVersion({}, (err, res) => {
        if (!!err && err.details === unknownServiceErr) {
          return cbk(null, {is_legacy: true});
        }

        if (!!err) {
          return cbk([503, 'UnexpectedVersionErrorForPaymentInit', {err}]);
        }

        return cbk(null, {commit_hash: res.commit_hash, is_legacy: false});
      });
    },

    // Determine the maximum CLTV delta
    maxCltvDelta: ['getHeight', ({getHeight}, cbk) => {
      if (!args.max_timeout_height) {
        return cbk();
      }

      const currentHeight = getHeight.current_block_height;

      const maxDelta = cltvLimit(args.max_timeout_height, currentHeight);

      // The max cltv delta cannot be lower than the final cltv delta + buffer
      if (!!maxDelta && !!finalCltv && maxDelta < finalCltv + cltvBuf) {
        return cbk([400, 'MaxTimeoutTooNearCurrentHeightToMakePayment']);
      }

      return cbk(null, maxDelta);
    }],

    // Determine channel id restrictions if applicable, check compatibility
    outgoingChannelIds: ['getVersion', ({getVersion}, cbk) => {
      if (!!args.outgoing_channel && !args.outgoing_channels) {
        return cbk(null, [numberFromChannel(args.outgoing_channel)]);
      }

      if (!args.outgoing_channels) {
        return cbk();
      }

      if (!isArray(args.outgoing_channels)) {
        return cbk([400, 'ExpectedArrayOfOutgoingChannelIdsToSubscribeToPay']);
      }

      if (!!getVersion.is_legacy) {
        return cbk([501, 'BackingLndVersionDoesNotSupportManyChannelOuts']);
      }

      if (getVersion.commit_hash === singleChanIdsCommitHash) {
        return cbk([501, 'BackingLndVersionDoesNotSupportMultipleChannelIds']);
      }

      return cbk(null, args.outgoing_channels.map(channel => {
        return chanNumber({channel}).number;
      }));
    }],

    // Final payment parameters
    params: [
      'getVersion',
      'maxCltvDelta',
      'outgoingChannelIds',
      ({getVersion, maxCltvDelta, outgoingChannelIds}, cbk) =>
    {
      const amounts = paymentAmounts({
        max_fee: args.max_fee,
        max_fee_mtokens: args.max_fee_mtokens,
        mtokens: args.mtokens,
        request: args.request,
        tokens: args.tokens,
      });

      const destTlv = messages.reduce((tlv, n) => {
        tlv[n.type] = Buffer.from(n.value, 'hex');

        return tlv;
      },
      {});

      return cbk(null, {
        allow_self_payment: true,
        amt: amounts.tokens,
        amt_msat: amounts.mtokens,
        cltv_limit: !!args.max_timeout_height ? maxCltvDelta : undefined,
        dest: !args.destination ? undefined : hexToBuf(args.destination),
        dest_custom_records: !messages.length ? undefined : destTlv,
        dest_features: features,
        fee_limit_msat: amounts.max_fee_mtokens,
        fee_limit_sat: amounts.max_fee,
        final_cltv_delta: !args.request ? finalCltv : undefined,
        last_hop_pubkey: hexToBuf(args.incoming_peer),
        max_parts: args.max_paths || undefined,
        no_inflight_updates: true,
        outgoing_chan_id: !channel ? undefined : chanNumber({channel}).number,
        outgoing_chan_ids: outgoingChannelIds,
        payment_hash: !args.id ? undefined : hexToBuf(args.id),
        payment_request: !args.request ? undefined : args.request,
        route_hints: !hints.length ? undefined : hints,
        timeout_seconds: timeoutSecs || defaultTimeoutSeconds,
      });
    }],

    // Send payment with legacy router rpc, before 0.9.2 LND
    sendLegacy: ['getVersion', 'params', ({getVersion, params}, cbk) => {
      // Exit early when using the current routerrpc
      if (!getVersion.is_legacy) {
        return cbk();
      }

      const sub = args.lnd.router_legacy.sendPayment(params);

      sub.on('data', data => emitLegacyPayment({data, emitter}));
      sub.on('end', () => cbk());
      sub.on('error', err => cbk(err));

      return;
    }],

    // Send payment
    send: ['getVersion', 'params', ({getVersion, params}, cbk) => {
      // Exit early when the wallet version is a legacy version
      if (!!getVersion.is_legacy) {
        return cbk();
      }

      const sub = args.lnd.router.sendPaymentV2(params);

      sub.on('data', data => emitPayment({data, emitter}));
      sub.on('end', () => cbk());
      sub.on('error', err => cbk(err));

      return;
    }],
  },
  err => {
    return nextTick(() => {
      if (!!err) {
        return emitError(err);
      }

      return;
    });
  });

  return emitter;
};