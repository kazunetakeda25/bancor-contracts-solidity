module.exports = {
    contracts_directory: './solidity',
    contracts_build_directory: './solidity/build/contracts',
    networks: {
        development: {
            host:       "localhost",
            port:       7545,
            network_id: "*",         // Match any network id
            gasPrice:   20000000000, // Gas price used for deploys
            gas:        6721975      // Gas limit used for deploys
        },
        production: {
            host:       "localhost",
            port:       7545,
            network_id: "*",         // Match any network id
            gasPrice:   20000000000, // Gas price used for deploys
            gas:        6721975      // Gas limit used for deploys
        },
        coverage: {     // See <https://www.npmjs.com/package/solidity-coverage#network-configuration>
            host:       "localhost",
            port:       7555,            // Also in .solcover.js
            network_id: "*",             // Match any network id
            gasPrice:   0x1,             // Gas price used for deploys
            gas:        0x1fffffffffffff // Gas limit used for deploys
        }
    },
    mocha: {
        enableTimeouts: false,
        useColors:      true,
        bail:           true,
        reporter:       "list"
    },
    compilers: {
        solc: {
            version: '0.4.26',
            settings: {
                optimizer: {
                    enabled: true,
                    runs: 1000,
                },
            },
        },
    }
};
