module.exports = Object.assign(function(commandApi){

    return commandApi
        .getOutput()
        .then(({ stdout })=> stdout);

}, { data_type: "filesystem" });