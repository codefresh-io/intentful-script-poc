const
    _ = require('lodash'),
    https = require('https'),
    Stream = require('stream'),
    stringifyQueryString = require('querystring').stringify,
    { PassThrough } = require('stream'),
    bufferToString = (buffer)=> buffer.toString('utf8'),
    bufferResponse = function(request){
        let buffer = [];
        return new Promise((resolve, reject)=> {
            request.once('response', (response) => {
                response.on('data', buffer.push.bind(buffer));
                response.once('error', reject);
                response.once('end', _.flow(()=> Buffer.concat(buffer), ~~(response.statusCode / 100) === 2 ? resolve : reject));
            });
            request.once('error', reject);
        });
    },
    streamResponse = function(request){
        return new Promise((resolve, reject)=> {
            request.once('response', (response)=> {
                resolve(response);
                request.once('error', reject);
            });
            request.once('error', reject);
        });
    },
    duplexResponse = function(request){

        let [stdout, stderr] = Array.from(new Array(2)).map(()=> (new PassThrough()).resume()); // --> disable backpressure control ("auto drain")
        let activeMode, capturePayload, captureHeader, buffer = Buffer.allocUnsafe(0);

        capturePayload = function(mode, length){
            return function(){
                if(buffer.length >= length){
                    ([, stdout, stderr][mode]).write(buffer.slice(0, length));
                    activeMode = captureHeader;
                    buffer = buffer.slice(length);
                    activeMode();
                }
            };
        };

        captureHeader = function(){
            if(buffer.length >= 8){
                activeMode = capturePayload(buffer[0], buffer.readUInt32BE(4));
                buffer = buffer.slice(8);
                activeMode();
            }
        };

        activeMode = captureHeader;

        return new Promise((resolve, reject)=> {

            request.once('response', ({ statusCode })=> {
               if(statusCode !== 101) reject(new Error(`HTTP Status Code ${statusCode}`));
            });

            request.once('upgrade', (response, socket)=> {
                socket.on('data', (chunk)=> {
                    buffer = Buffer.concat([buffer, chunk]);
                    activeMode();
                });

                socket.once('close', ()=> [stdout, stderr].forEach((stream)=> stream.end()));

                resolve({
                    write: socket.write.bind(socket),
                    stdout,
                    stderr
                });
            });
        });
    },
    requestGenerator = function({ version = "v1.28", host = "127.0.0.1", port = 2376, ca, cert, key }){
        return function(path = '', query = {}, method = 'GET', payload, headers) {
            let request = https.request(_.assign({
                host,
                port,
                ca,
                cert,
                key,
                query,
                method,
                headers,
                path: "/" + [
                    [version, path].join('/').split('/').filter(Boolean).join('/'),
                    stringifyQueryString(query)
                ].filter(Boolean).join('?')
            }, headers && { headers }));


            if(!(payload instanceof Stream)) {
                request.end(payload && (function(json){
                    request.setHeader('Content-Type', 'application/json');
                    return json;
                })(JSON.stringify(payload)));
            } else {
                request.setHeader('Content-Type', 'application/tar');
                payload.pipe(request);
            }

            return request;
        };
    };

module.exports = function(config){
    let request = requestGenerator(config);
    return {
        createExec: _.flow(({containerId, cmd, env = {}}) => request(`/containers/${containerId}/exec`, {}, 'POST', {
            AttachStdout: true,
            AttachStderr: true,
            AttachStdin: true,
            Env: _.map(env, (v, k) => [k, v].join('=')),
            Cmd: _.flatten([cmd])
        }), bufferResponse, (promise) => promise.then(_.flow(bufferToString, JSON.parse, ({Id}) => ({execId: Id})))),
        startExec: _.flow(({execId}) => request(`/exec/${execId}/start`, {}, 'POST', {}, {
            "Upgrade": "tcp",
            "Connection": "Upgrade"
        }), duplexResponse),
        inspectExec: _.flow(({execId}) => request(`/exec/${execId}/json`), bufferResponse, (promise) => promise.then(_.flow(bufferToString, JSON.parse, ({ExitCode, Running}) => ({
            exit_code: ExitCode,
            active: Running
        })))),
        createContainer: _.flow(({name, image, cmd, env = {}}) => request('/containers/create', {name}, 'POST', {
            AttachStdout: true,
            AttachStderr: true,
            AttachStdin: true,
            Env: _.map(env, (v, k) => [k, v].join('=')),
            Cmd: _.flatten([cmd]),
            Image: image,
            EntryPoint: []
        }), bufferResponse, (promise) => promise.then(_.flow(bufferToString, JSON.parse, ({Id}) => ({containerId: Id})))),
        removeContainer: _.flow(({containerId}) => request(`/containers/${containerId}`, {
            v: true,
            force: true
        }, 'DELETE'), bufferResponse),
        startContainer: _.flow(({containerId}) => request(`/containers/${containerId}/start`, {}, 'POST'), bufferResponse, (promise) => promise.then(_.flow(bufferToString))),
        getContainer: _.flow(() => request('/containers/json', {all: true}), bufferResponse),
        attachContainer: _.flow(({containerId}) => request(`/containers/${containerId}/attach`, {
            stream: true,
            stdout: true,
            stderr: true,
            stdin: true
        }, 'POST', {}, {"Upgrade": "tcp", "Connection": "Upgrade"}), duplexResponse),
        pullImage: _.flow(({ imageName, username, password })=> request('/images/create', { fromImage: imageName }, 'POST', undefined, username && { "X-Registry-Auth": Buffer.from(JSON.stringify({username, password})).toString('base64') }), bufferResponse),
        inspectImage: _.flow(({ imageName })=> request(`/images/${imageName}/json`), bufferResponse),
        getFileSystemPath: _.flow(({ containerId, path }) => request(`/containers/${containerId}/archive`, {path}, 'GET'), streamResponse),
        setFileSystemPath: _.flow(({ containerId, path, stream }) => request(`/containers/${containerId}/archive`, {path, noOverwriteDirNonDir: true}, 'PUT', stream), bufferResponse)
    }
};