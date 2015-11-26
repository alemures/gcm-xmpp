gcm-xmpp
===
Connects to GCM servers using a XMPP protocol.

## Install
npm install gcm-xmpp

## Example
```
var Client = require('gcm-xmpp');
var client = new Client('<sender_id>', '<api_key>');
client.on('connected', function(info) {
  client.send('<registration_id>', { data: { message:'Hello' } }, function(err, result) {
    if (err) {
      console.log(err);
      return;
    }

    console.log(result);
  });
});
client.connect();
```