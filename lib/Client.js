'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');

var debug = require('debug')('gcm-xmpp:Client');
var ut = require('ut');
var xmpp = require('node-xmpp-client');

// Constants

var HOST = 'gcm-xmpp.googleapis.com';
var PORT = 5235;
var TEST_HOST = 'gcm-preprod.googleapis.com';
var TEST_PORT = 5236;

var MAX_PENDING_MESSAGES = 100;

// Class Client

function Client(senderId, apiKey, options) {
  Client.super_.call(this);

  options = options !== undefined ? options : {};

  this.jid = senderId + '@gcm.googleapis.com';
  this.password = apiKey;
  this.host = !options.test ? HOST : TEST_HOST;
  this.port = !options.test ? PORT : TEST_PORT;

  this.connection = null;
  this.drainingConnections = [];

  this.queue = [];
  this.pendingMessages = 0;

  this.connected = false;
  this.connecting = false;

  this.cbs = {};
}

util.inherits(Client, EventEmitter);

Client.messageIdSeed = 1;

/**
 * Sends a push notification.
 *
 * @param {String} to The registration id
 * @param {Object} optional payload The payload value 'notification' or 'data'
 * @param {Object} optional options The options
 * @param {Function} optional cb The callback
 * @return {Boolean} true if the push was sent, false if it was added to queue
 */
Client.prototype.send = function(to, payload, options, cb) {
  cb = ut.isFunction(payload) ? payload :
      ut.isFunction(options) ? options : cb;
  payload = ut.isPlainObject(payload) ? payload : {};
  options = ut.isPlainObject(options) ? options : {};

  var json = {
    to: to,
    message_id: this._getMessageId()
  };

  ut.mergeObjects(json, payload);
  ut.mergeObjects(json, options);

  return this._send(json, cb);
};

Client.prototype._send = function(json, cb) {
  if (this.connected && this.pendingMessages < MAX_PENDING_MESSAGES) {
    var stanza = new xmpp.Stanza.Element('message')
      .c('gcm', { xmlns: 'google:mobile:data' }).t(JSON.stringify(json));
    debug('sending %s', stanza.toString());

    if (cb !== undefined) {
      this.cbs[json.message_id] = cb;
    }

    this.connection.send(stanza);
    this.pendingMessages++;
    return true;
  } else {
    debug('queuing %j', json);
    this.queue.push({ json: json, cb: cb });
    return false;
  }
};

Client.prototype.end = function() {
  if (this.connected) {
    this.connection.end();
  }

  if (this.drainingConnections.length > 0) {
    var i;
    var length = this.drainingConnections.length;

    for (i = 0; i < length; i++) {
      this.drainingConnections[i].end();
    }
  }

  this.connected = false;
  this.connecting = false;
};

Client.prototype.connect = function() {
  this.connecting = true;

  debug('connecting ' + this.host + ':' + this.port);

  this.connection = new xmpp.Client({
    jid: this.jid,
    password: this.password,
    host: this.host,
    port: this.port,
    legacySSL: true,
    preferredSaslMechanism: 'PLAIN'
  });

  this.connection.connection.socket.setTimeout(0);
  this.connection.connection.socket.setKeepAlive(true, 10000);

  this._addListeners();
};

// Called for every ack or nack received
Client.prototype.callback = function(messageId) {
  var args = ut.argumentsToArray(arguments).slice(1);

  if (this.cbs[messageId] !== undefined) {
    this.cbs[messageId].apply(this, args);
    delete this.cbs[messageId];
  }

  this.pendingMessages--;
  this._flushQueue();
};

Client.prototype._addListeners = function() {
  var _this = this;

  this.connection.on('online', this._onOnline.bind(this));
  this.connection.on('stanza:preauth', this._onStanzaPreauth.bind(this));
  this.connection.on('auth', this._onAuth.bind(this));
  this.connection.on('stanza', this._onStanza.bind(this));
  this.connection.on('offline', function() {
    _this._onOffline.call(_this, this);
  });

  this.connection.on('error', this._onError.bind(this));
};

Client.prototype._onOnline = function(info) {
  this.connected = true;
  this.connecting = false;

  debug('connected');
  this.emit('connected', info);

  this._flushQueue();
};

Client.prototype._onStanzaPreauth = function(stanza) {
  debug('stanza preauth %s', stanza.toString());
};

Client.prototype._onAuth = function() {
  debug('valid auth');
  this.emit('auth');
};

Client.prototype._onStanza = function(stanza) {
  debug('new stanza %s', stanza.toString());

  var err;

  if (stanza.is('message')) {
    if (stanza.attrs.type !== 'error') {
      // Handle a correct stanza
      var json = JSON.parse(stanza.getChildText('gcm'));

      switch (json.message_type) {
        case 'control':
          if (json.control_type === 'CONNECTION_DRAINING') {
            this.connected = false;
            this.drainingConnections.push(this.connection);
            this.connect();
          }

          break;
        case 'nack':
          err = new Error(json.error_description);
          err.error = json.error;
          err.from = json.from;
          this.callback(json.message_id, err);
          break;
        case 'ack':
          this.callback(json.message_id, null, {
            message_id: json.message_id,
            from: json.from
          });
          break;
        case 'receipt':
          this.emit('message-delivered', {
            message_id: json.message_id,
            from: json.from,
            category: json.category,
            data: json.data
          });
          break;
        default:
          this._send({
            to: json.from,
            message_id: json.message_id,
            message_type: 'ack'
          });
          this.emit('message', {
            message_id: json.message_id,
            from: json.from,
            category: json.category,
            data: json.data
          });
          break;
      }
    } else {
      // Handle a stanza error
      var errorTag = stanza.getChild('error');
      var code = errorTag.attrs.code;
      var text = errorTag.getChild('text').getText();
      err = new Error(text);
      err.code = code;
      err.json = stanza.getChildText('gcm');

      debug('stanza-error', err);
      this.emit('message-error', err);
    }
  } else {
    debug('unrecognized stanza %s', stanza.getName());
  }
};

Client.prototype._onOffline = function(connection) {
  // A draining connection was closed
  if (connection !== this.connection) {
    var index = this.drainingConnections.indexOf(connection);
    if (index > -1) {
      this.drainingConnections.splice(index, 1);
    }

    return;
  }

  // The main connection was closed
  this.connecting = false;
  this.connected = false;
  ut.clearArray(this.queue);
  this.cbs = {};
  this.pendingMessages = 0;

  debug('disconnected');
  this.emit('disconnected');
};

Client.prototype._onError = function(error) {
  for (var i in this.cbs) {
    this.cbs[i](error);
  }

  this.cbs = {};

  debug(error);
  this.emit('error', error);
};

Client.prototype._getMessageId = function() {
  return ut.numberToString(Client.messageIdSeed++);
};

Client.prototype._flushQueue = function() {
  if (this.queue.length > 0) {
    var n = Math.min(MAX_PENDING_MESSAGES - this.pendingMessages,
        this.queue.length);
    var i;

    debug('Sending %d message from queue', n);

    for (i = 0; i < n; i++) {
      this._send(this.queue[i].json, this.queue[i].cb);
    }

    this.queue.splice(0, n);
  }
};

module.exports = Client;
