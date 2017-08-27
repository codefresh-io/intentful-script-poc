const
    _ = require('lodash'),
    https = require('https'),
    Stream = require('stream'),
    EventEmitter = require('events').EventEmitter,
    stringifyQueryString = require('querystring').stringify,
    { PassThrough } = require('stream'),
    bufferToString = (buffer)=> buffer.toString('utf8'),
    bufferResponse = function(request){
        let buffer = [];
        return new Promise((resolve, reject)=> {
            request.once('response', (response) => {
                response.on('data', buffer.push.bind(buffer));
                response.once('error', reject);
                response.once('end', _.flow(()=>
                    Buffer.concat(buffer),
                    bufferToString,
                    response.headers["content-type"] === "application/json" ? _.partial(_.attempt, JSON.parse) : _.identity,
                    (body)=> ((~~(response.statusCode / 100) === 2 && !_.isError(body)) ? resolve : reject)(body))
                );
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

        let [stdout, stderr, stdin] = Array.from(new Array(3)).map(()=> (new PassThrough()).resume()); // --> disable backpressure control ("auto drain")
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
                stdin.pipe(socket);

                socket.on('data', (chunk)=> {
                    buffer = Buffer.concat([buffer, chunk]);
                    activeMode();
                });

                socket.once('close', ()=> [stdout, stderr, stdin].forEach((stream)=> stream.end()));

                resolve({
                    stdin,
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

const REQUEST = Symbol('Request');

module.exports = class extends EventEmitter {

    constructor(config){
        super();
        this[REQUEST] = requestGenerator(config);
    }

    createExec({containerId, cmd, env = {}}){
        return bufferResponse(this[REQUEST](`/containers/${containerId}/exec`, {}, 'POST', {
            AttachStdout: true,
            AttachStderr: true,
            AttachStdin: true,
            Env: _.map(env, (v, k) => [k, v].join('=')),
            Cmd: _.flatten([cmd])
        }));
    }

    startExec({execId}){
        return duplexResponse(this[REQUEST](`/exec/${execId}/start`, {}, 'POST', {}, {
            "Upgrade": "tcp",
            "Connection": "Upgrade"
        }));
    }

    inspectExec({execId}){
        return bufferResponse(this[REQUEST](`/exec/${execId}/json`));
        /*, ({ExitCode, Running}) => ({
                exit_code: ExitCode,
                active: Running
            })));*/
    }

    createContainer({name, image, cmd, env = {}}){
        return bufferResponse(this[REQUEST]('/containers/create', {name}, 'POST', {
            AttachStdout: true,
            AttachStderr: true,
            AttachStdin: true,
            Privileged: true,
            Env: _.map(env, (v, k) => [k, v].join('=')),
            Cmd: _.flatten([cmd]),
            Image: image,
            EntryPoint: []
        }));
    }

    removeContainer({containerId}){
        return bufferResponse(this[REQUEST](`/containers/${containerId}`, {
            v: true,
            force: true
        }, 'DELETE'));
    }

    startContainer({containerId}){
        return bufferResponse(this[REQUEST](`/containers/${containerId}/start`, {}, 'POST'));
    }

    getContainer(){
        return bufferResponse(this[REQUEST]('/containers/json', {all: true}));
    }

    attachContainer({containerId}){
        return duplexResponse(this[REQUEST](`/containers/${containerId}/attach`, {
            stream: true,
            stdout: true,
            stderr: true,
            stdin: true
        }, 'POST', {}, {"Upgrade": "tcp", "Connection": "Upgrade"}));
    }

    pullImage({ imageName, username, password }){
        return bufferResponse(this[REQUEST]('/images/create', { fromImage: imageName }, 'POST', undefined, username && { "X-Registry-Auth": Buffer.from(JSON.stringify({username, password})).toString('base64') }));
    }

    inspectImage({ imageName }){
        return bufferResponse(this[REQUEST](`/images/${imageName}/json`));
    }

    getFileSystemPath({ containerId, path }){
        return streamResponse(this[REQUEST](`/containers/${containerId}/archive`, {path}, 'GET'));
    }

    setFileSystemPath({ containerId, path, stream }){
        return bufferResponse(this[REQUEST](`/containers/${containerId}/archive`, {path, noOverwriteDirNonDir: true}, 'PUT', stream));
    }
};