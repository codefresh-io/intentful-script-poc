const
    _ = require('lodash'),
    split = require('split'),
    kefir = require('kefir');

const
    TOTAL_COUNT_REGEXP = /^1\.\.([0-9]+)/,
    LINE_REGEXP = /^((not )?ok)\s?([0-9]*)\s?(.*)/;

module.exports = function({ stdout }){
    let lineStream = kefir
        .fromEvents(stdout.pipe(split()), 'data')
        .takeUntilBy(kefir.fromEvents(stdout, 'end').take(1));

    let totalTestCountProperty = lineStream
        .filter((line)=> TOTAL_COUNT_REGEXP.test(line))
        .take(1)
        .map((line)=> +_.last(line.match(TOTAL_COUNT_REGEXP)))
        .toProperty();

    let testResultProperty = lineStream
        .filter((line)=> LINE_REGEXP.test(line))
        .map((line)=> {
            let [status,, serial, description] = Array.from(line.match(LINE_REGEXP)).slice(1);
            return { pass: status === "ok", serial: +serial,  description };
        })
        .scan((a,b)=> a.concat(b), [])
        .last();

    return kefir
        .combine([totalTestCountProperty, testResultProperty])
        .map(([totalTestCount, testResult])=>({
            total: totalTestCount,
            pass: testResult.length === totalTestCount && testResult.every(_.property('pass')),
            report: testResult
        }))
        .toPromise()
};