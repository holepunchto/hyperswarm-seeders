# @hyperswarm/seeders

A seeders only swarm, verified by a mutable record

```
npm install @hyperswarm/seeders
```

Note that the list of seeds are stored in a verifiable record in the DHT,
meaning no one can spoof it, but other people can read it.

## Usage

``` js
const Seeders = require('@hyperswarm/seeders')

const swarm = new Seeders(firstSeedPublicKey, {
  dht, // optional dht new to use
  keyPair, // optional key pair to use, defaults to dht.defaultKeyPair
  maxClientConnections // how many connections to make to the seed, defaults to 2
})

swarm.on('connection', function (connection) {
  console.log('got connection...')
})

// if you are the first seed, add more seeds by passing a record
if (swarm.owner) {
  await swarm.join({
    seeds: [
      publicKey1,
      publicKey2,
      ...
    ],
    // optionally add info about the hypercore being seeded
    core: {
      length: 42,
      fork: 0
    }
  })
} else {
  await swarm.join()
}
```

## License

MIT
