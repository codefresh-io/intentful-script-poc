const
    _ = require('lodash'),
    kefir = require('kefir');

module.exports = _.assign(function(commandApi){

    return kefir
        .fromPromise(commandApi.getExitCode())
        .map((code)=>({ pass: code === 0 }))
        .toPromise();

}, { data_type: "test_report" });