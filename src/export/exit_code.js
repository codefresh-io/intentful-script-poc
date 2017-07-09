const kefir = require('kefir');

module.exports = function(commandApi){
    return commandApi.getExitCode();
};