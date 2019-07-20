# Contract `NonStandardSmartToken`



#### Functions:
- `constructor(string _name, string _symbol, uint8 _decimals)`
- `disableTransfers(bool _disable)`
- `issue(address _to, uint256 _amount)`
- `destroy(address _from, uint256 _amount)`
- `transfer(address _to, uint256 _value)`
- `transferFrom(address _from, address _to, uint256 _value)`

#### Events:
- `NewSmartToken(address _token)`
- `Issuance(uint256 _amount)`
- `Destruction(uint256 _amount)`

---

#### Function `constructor(string _name, string _symbol, uint8 _decimals)`
constructor

###### Parameters:
- `_name`:       token name

- `_symbol`:     token short symbol, minimum 1 character

- `_decimals`:   for display purposes only
#### Function `disableTransfers(bool _disable)`
disables/enables transfers
can only be called by the contract owner

###### Parameters:
- `_disable`:    true to disable transfers, false to enable them
#### Function `issue(address _to, uint256 _amount)`
increases the token supply and sends the new tokens to an account
can only be called by the contract owner

###### Parameters:
- `_to`:         account to receive the new amount

- `_amount`:     amount to increase the supply by
#### Function `destroy(address _from, uint256 _amount)`
removes tokens from an account and decreases the token supply
can be called by the contract owner to destroy tokens from any account or by any holder to destroy tokens from his/her own account

###### Parameters:
- `_from`:       account to remove the amount from

- `_amount`:     amount to decrease the supply by
#### Function `transfer(address _to, uint256 _value)`
send coins
throws on any error rather then return a false flag to minimize user errors
in addition to the standard checks, the function throws if transfers are disabled

###### Parameters:
- `_to`:      target address

- `_value`:   transfer amount
#### Function `transferFrom(address _from, address _to, uint256 _value)`
an account/contract attempts to get the coins
throws on any error rather then return a false flag to minimize user errors
in addition to the standard checks, the function throws if transfers are disabled

###### Parameters:
- `_from`:    source address

- `_to`:      target address

- `_value`:   transfer amount

#### Event `NewSmartToken(address _token)`
No description
#### Event `Issuance(uint256 _amount)`
No description
#### Event `Destruction(uint256 _amount)`
No description


