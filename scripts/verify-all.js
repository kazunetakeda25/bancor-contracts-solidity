const WORK_DIR = './solidity';
const NODE_DIR = '../node_modules';
const INPUT_FILE = process.argv[2];

const fs = require('fs');
const path = require('path');
const request = require('request');
const spawnSync = require('child_process').spawnSync;

const input = JSON.parse(fs.readFileSync(INPUT_FILE, { encoding: 'utf8' }));
//  input example:
//  {
//      "network"        : "api", // use "api" for mainnet or "api-<testnet>" for testnet
//      "apiKey"         : "",    // generate this value at https://etherscan.io/myapikey
//      "compilerVersion": "v0.6.12+commit.27d51765",
//      "optimization"   : {"used": 1, "runs": 200},
//      "contracts"      : {
//          "ContractA1": {"name": "ContractA", "addr": "0x0000000000000000000000000000000000000001", "args": "<abi-encoded constructor arguments>"},
//          "ContractA2": {"name": "ContractA", "addr": "0x0000000000000000000000000000000000000002", "args": "<abi-encoded constructor arguments>"},
//          "ContractB1": {"name": "ContractB", "addr": "0x0000000000000000000000000000000000000003", "args": "<abi-encoded constructor arguments>"},
//          "ContractC1": {"name": "ContractC", "addr": "0x0000000000000000000000000000000000000004", "args": "<abi-encoded constructor arguments>"},
//      }
//  }

const run = () => {
    for (const pathName of getPathNames('contracts')) {
        const contractName = path.basename(pathName, '.sol');
        for (const contractId of Object.keys(input.contracts)) {
            if (input.contracts[contractId].name === contractName) {
                post(contractId, getSourceCode(pathName));
            }
        }
    }
};

const getPathNames = (dirName) => {
    let pathNames = [];
    for (const fileName of fs.readdirSync(WORK_DIR + '/' + dirName)) {
        if (fs.statSync(WORK_DIR + '/' + dirName + '/' + fileName).isDirectory()) {
            pathNames = pathNames.concat(getPathNames(dirName + '/' + fileName));
        }
        else if (fileName.endsWith('.sol')) {
            pathNames.push(dirName + '/' + fileName);
        }
    }
    return pathNames;
};

const getSourceCode = (pathName) => {
    const result = spawnSync('node', [NODE_DIR + '/truffle-flattener/index.js', pathName], { cwd: WORK_DIR });

    // removing all occurrences of SPDX license identifiers except first
    // TODO: this is only ok if all files have the same license
    let i = 0;
    const source = result.output.toString().replace(/\/\/ SPDX-License-Identifier.*/g, m  => !i++ ? m : '');
    return source.slice(1, -1);
};

const post = (contractId, sourceCode) => {
    console.log(contractId + ': sending verification request...');
    request.post({
        url: 'https://' + input.network + '.etherscan.io/api',
        form: {
            module: 'contract',
            action: 'verifysourcecode',
            sourceCode: sourceCode,
            apikey: input.apiKey,
            compilerversion: input.compilerVersion,
            optimizationUsed: input.optimization.used,
            runs: input.optimization.runs,
            contractname: input.contracts[contractId].name,
            contractaddress: input.contracts[contractId].addr,
            constructorArguements: input.contracts[contractId].args
        }
    },
    (error, response, body) => {
        if (error) {
            console.log(contractId + ': ' + error);
        }
        else {
            body = parse(body);
            if (body.status === '1') {
                get(contractId, body.result);
            }
            else {
                console.log(contractId + ': ' + body.result);
            }
        }
    });
};

const get = (contractId, guid) => {
    console.log(contractId + ': checking verification status...');
    request.get(
        'https://' + input.network + '.etherscan.io/api?module=contract&action=checkverifystatus&guid=' + guid,
        (error, response, body) => {
            if (error) {
                console.log(contractId + ': ' + error);
            }
            else {
                body = parse(body);
                if (body.result === 'Pending in queue' || (body.result && body.result.startsWith('Max rate limit reached'))) {
                    get(contractId, guid);
                }
                else {
                    console.log(contractId + ': ' + body.result);
                }
            }
        }
    );
};

const parse = (str) => {
    try {
        return JSON.parse(str);
    } catch (error) {
        return {};
    }
};

run();
