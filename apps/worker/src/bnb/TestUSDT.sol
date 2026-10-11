// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Rove test USDT (tUSDT) for BSC testnet (chainId 97). TESTNET ONLY: worth nothing; the deployer mints at will.
/// @notice Minimal ERC-20 for the Rove BNB pay-in demo (docs/specs/bnb-lane.md). 18 decimals, like BSC's USDT.
/// Compiled by `scripts/bsc-setup.ts compile` (solc 0.8.26, optimizer 200 runs, evmVersion paris); the bytecode is
/// committed in tusdt.ts.
contract TestUSDT {
    string public constant name = "Rove Test USDT";
    string public constant symbol = "tUSDT";
    uint8 public constant decimals = 18;

    address public immutable owner;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        owner = msg.sender;
    }

    function mint(address to, uint256 value) external {
        require(msg.sender == owner, "tUSDT: only the deployer mints");
        require(to != address(0), "tUSDT: mint to zero");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "tUSDT: allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "tUSDT: transfer to zero");
        uint256 balance = balanceOf[from];
        require(balance >= value, "tUSDT: balance");
        unchecked {
            balanceOf[from] = balance - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
