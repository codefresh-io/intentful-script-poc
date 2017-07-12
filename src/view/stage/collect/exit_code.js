const _ = require('lodash');

module.exports = _.assign(function(commandApi){

    return commandApi.getExitCode();

}, { data_type: "exit_code" });