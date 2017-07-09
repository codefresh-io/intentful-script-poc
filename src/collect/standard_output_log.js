let
    _ = require('lodash'),
    split = require('split'),
    kefir = require('kefir');

module.exports = _.assign(function(commandApi){
    return kefir
        .fromPromise(commandApi.getOutput())
        .flatMap(({ stderr, stdout })=> {
            return kefir
                .merge([stderr, stdout].map((stream)=> kefir.fromEvents(stream.pipe(split()), 'data', (data)=> ({ stream: stream === stderr ? "error" : "output", timestamp: Date.now(), data }))))
                .scan((a,b)=> a.concat(b), [])
                .takeUntilBy(kefir.fromEvents(stdout, 'end').take(1))
                .last();
        })
        .toPromise();
}, { data_type: "log" });