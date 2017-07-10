const _ = require('lodash');

module.exports = _.assign(function(commandApi, { path }){
    return commandApi.getFileSystem(path).then((stream)=> stream);    // TBD: consider whether the API should utilize auto drainage (.resume())
}, { data_type: "tar" });
