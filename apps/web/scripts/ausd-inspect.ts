// Prints the AUSD token facts on Base Sepolia with read-only RPC calls (no keys, no gas).
//   pnpm --filter web exec tsx scripts/ausd-inspect.ts [address ...]
import { createPublicClient, http, keccak256, parseAbi, toHex } from "viem";
import { baseSepolia } from "viem/chains";

const rpc = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const token = (process.env.AUSD_TOKEN_ADDRESS || "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC") as `0x${string}`;
const c = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function totalSupply() view returns (uint256)",
  "function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address, bytes32) view returns (bool)",
]);

async function read(fn: string, args: unknown[] = []): Promise<unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await c.readContract({ address: token, abi, functionName: fn as any, args: args as any });
  } catch (e) {
    return `ERR ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}`;
  }
}

async function main(): Promise<void> {
console.log("rpc", rpc, "chainId", await c.getChainId(), "token", token);
for (const fn of ["name", "symbol", "decimals", "version", "DOMAIN_SEPARATOR", "eip712Domain", "totalSupply", "TRANSFER_WITH_AUTHORIZATION_TYPEHASH"]) {
  console.log(fn, await read(fn));
}
console.log("authorizationState(0x…01, 0x00…)", await read("authorizationState", ["0x0000000000000000000000000000000000000001", `0x${"00".repeat(32)}`]));
console.log(
  "expected TransferWithAuthorization typehash",
  keccak256(toHex("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")),
);
const code = await c.getCode({ address: token });
console.log("code bytes", code ? (code.length - 2) / 2 : 0);
for (const a of process.argv.slice(2)) {
  console.log("balance", a, "AUSD units", await read("balanceOf", [a]), "ETH wei", await c.getBalance({ address: a as `0x${string}` }));
}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
