const _ = require('lodash');

module.exports = _.assign(function(commandApi, { path }){

    return commandApi.getExitCode().then(()=> commandApi.getFileSystem(path));   // TBD: consider whether the API should utilize auto drainage (.resume())

}, { data_type: "filesystem" });
