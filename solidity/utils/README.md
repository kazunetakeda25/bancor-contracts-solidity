## Utilities

### [Prerequisites](../../README.md#prerequisites)

### [Installation](../../README.md#installation)

Following installation, `yarn build` should be executed once.

### Test Deployment

Deploys a set of contracts for testing purpose; can be used on both private and public networks:

```bash
node test_deployment.js
    Configuration file name
    Ethereum node address
    Account private key
```

The configuration file is updated during the process, in order to allow resuming a prematurely-terminated execution.

Here is an example of the initial configuration file which should be provided to the process:

```json
{
    "reserves": [
        {
            "type": 0,
            "symbol": "XXX",
            "supply": "1829101"
        },
        {
            "type": 0,
            "symbol": "YYY",
            "supply": "3603801"
        },
        {
            "type": 1,
            "symbol": "BNT",
            "supply": "6914855"
        },
        {
            "type": 1,
            "symbol": "vBNT",
            "supply": "0"
        },
        {
            "address": "0xBde8bB00A7eF67007A96945B3a3621177B615C44",
            "optional": "this is the already-deployed WBTC token"
        },
        {
            "address": "0x443Fd8D5766169416aE42B8E050fE9422f628419",
            "optional": "this is the already-deployed BAT token"
        },
        {
            "address": "0x20fE562d797A42Dcb3399062AE9546cd06f63280",
            "optional": "this is the already-deployed LINK token"
        }
    ],
    "converters": [
        {
            "type": 3,
            "symbol": "ETHBNT",
            "decimals": 18,
            "fee": "0.1%",
            "reserves": [
                {
                    "symbol": "ETH",
                    "weight": "50%",
                    "balance": "21"
                },
                {
                    "symbol": "BNT",
                    "weight": "50%",
                    "balance": "3092"
                }
            ]
        },
        {
            "type": 3,
            "symbol": "XXXBNT",
            "decimals": 18,
            "fee": "0.1%",
            "reserves": [
                {
                    "symbol": "XXX",
                    "weight": "50%",
                    "balance": "582"
                },
                {
                    "symbol": "BNT",
                    "weight": "50%",
                    "balance": "2817"
                }
            ]
        },
        {
            "type": 1,
            "symbol": "YYYBNT",
            "decimals": 18,
            "fee": "0.2%",
            "reserves": [
                {
                    "symbol": "YYY",
                    "weight": "40%",
                    "balance": "312"
                },
                {
                    "symbol": "BNT",
                    "weight": "60%",
                    "balance": "270"
                }
            ]
        }
    ],
    "liquidityProtectionParams": {
        "minNetworkTokenLiquidityForMinting": "100",
        "defaultNetworkTokenMintingLimit": "750",
        "minProtectionDelay": 600,
        "maxProtectionDelay": 3600,
        "lockDuration": 60,
        "converters": ["ETHBNT", "XXXBNT"]
    }
}
```
