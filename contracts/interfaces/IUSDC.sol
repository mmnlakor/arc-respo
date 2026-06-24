// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// ─────────────────────────────────────────────────────────────────────────────
// IUSDC — Arc Testnet USDC ERC-20 interface
//
// Arc-specific:
//   Address:        0x3600000000000000000000000000000000000000
//   ERC-20 decimals: 6   → use for transferFrom, balanceOf, approve
//   Native decimals: 18  → use for msg.value, address.balance (gas)
//   These are the SAME underlying asset — never mix raw values.
// ─────────────────────────────────────────────────────────────────────────────

interface IUSDC {
    function name()                                          external view returns (string memory);
    function symbol()                                        external view returns (string memory);
    function decimals()                                      external view returns (uint8);
    function totalSupply()                                   external view returns (uint256);
    function balanceOf(address account)                      external view returns (uint256);
    function allowance(address owner, address spender)       external view returns (uint256);
    function transfer(address to, uint256 amount)            external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount)        external returns (bool);

    event Transfer(address indexed from,  address indexed to,      uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
