const
    _ = require('lodash'),
    kefir = require('kefir');

module.exports = _.assign(function(commandApi){
    return commandApi.getExitCode();
}, { data_type: "exit_code" });