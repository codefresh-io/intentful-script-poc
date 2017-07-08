let
    _ = require('lodash'),
    split = require('split'),
    kefir = require('kefir');

module.exports = function({ stderr, stdout }){
    return kefir
        .merge([stderr, stdout].map((stream)=> kefir.fromEvents(stream.pipe(split()), 'data')))
        .map((data)=>({ timestamp: Date.now(), data }))
        .scan((a,b)=> a.concat(b), [])
        .takeUntilBy(kefir.fromEvents(stdout, 'end').take(1))
        .last()
        .toPromise();
};