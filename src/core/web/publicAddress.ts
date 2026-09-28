// Whether an IP address is on the public internet (M69, PLAN.md D49, the
// M44b design): web fetch connects only to such an address, so a page, a
// redirect or a DNS answer cannot aim the extension at the user's own
// machine, their network, a carrier-grade NAT or a cloud metadata service.
// IPv4 is public unless it falls in a special-purpose block; IPv6 only inside
// global unicast (2000::/3) and outside its special blocks, and an IPv6 form
// that carries an IPv4 address (mapped, compatible, NAT64, 6to4) is judged by
// that address. Pure; the ranges are in constants.ts.

import { isIPv4, isIPv6 } from 'node:net'
import {
  ADDRESS_FAMILIES,
  type AddressFamily,
  IPV6_EMBEDDED_IPV4_PREFIXES,
  IPV6_GLOBAL_UNICAST,
  IPV6_SIX_TO_FOUR,
  NON_PUBLIC_IPV4_RANGES,
  NON_PUBLIC_IPV6_RANGES,
} from '../../shared/constants'

const NO_BITS = 0n
const ONE_BIT = 1n
const IPV4_BITS = 32n
const IPV6_BITS = 128n
const OCTET_BITS = 8n
const GROUP_BITS = 16n
const IPV6_GROUPS = 8
const HEX = 16
// 6to4's IPv4 address sits below its 16-bit prefix, above 80 bits of subnet
// and interface.
const SIX_TO_FOUR_SHIFT = 80n
const IPV4_MASK = (ONE_BIT << IPV4_BITS) - ONE_BIT
const GROUP_MASK = (ONE_BIT << GROUP_BITS) - ONE_BIT
// An IPv6 zone (`fe80::1%eth0`) names a local interface: never public.
const ZONE_SEPARATOR = '%'
const GROUP_SEPARATOR = ':'
const ELISION = '::'

/** The address as a number; undefined for text that is not a dotted IPv4 address. */
function ipv4Value(text: string): bigint | undefined {
  if (!isIPv4(text)) {
    return undefined
  }
  let value = NO_BITS
  for (const octet of text.split('.')) {
    value = (value << OCTET_BITS) | BigInt(Number(octet))
  }
  return value
}

/** A dotted IPv4 tail (`::ffff:1.2.3.4`) as the two hexadecimal groups it stands for. */
function dottedAsGroups(text: string): string | undefined {
  const lastSeparator = text.lastIndexOf(GROUP_SEPARATOR)
  const tail = text.slice(lastSeparator + 1)
  if (!tail.includes('.')) {
    return text
  }
  const value = ipv4Value(tail)
  if (value === undefined) {
    return undefined
  }
  const high = Number(value >> GROUP_BITS)
  const low = Number(value & GROUP_MASK)
  return `${text.slice(0, lastSeparator + 1)}${high.toString(HEX)}:${low.toString(HEX)}`
}

/** The eight groups of an IPv6 address, the elision filled with zeros. */
function ipv6Groups(text: string): readonly string[] | undefined {
  const expanded = dottedAsGroups(text)
  if (expanded === undefined) {
    return undefined
  }
  // Before and after the one `::` a valid address may hold.
  const [left = '', right] = expanded.split(ELISION, 2)
  const head = left === '' ? [] : left.split(GROUP_SEPARATOR)
  if (right === undefined) {
    return head
  }
  const tail = right === '' ? [] : right.split(GROUP_SEPARATOR)
  const zeros = Array.from({ length: IPV6_GROUPS - head.length - tail.length }, () => '0')
  return [...head, ...zeros, ...tail]
}

/** The address as a number; undefined for text that is not an IPv6 address. */
function ipv6Value(text: string): bigint | undefined {
  if (text.includes(ZONE_SEPARATOR) || !isIPv6(text)) {
    return undefined
  }
  const groups = ipv6Groups(text)
  if (groups?.length !== IPV6_GROUPS) {
    return undefined
  }
  let value = NO_BITS
  for (const group of groups) {
    value = (value << GROUP_BITS) | BigInt(Number.parseInt(group, HEX))
  }
  return value
}

/** Whether `value` (an address `width` bits wide) is inside the prefix. */
function isInPrefix(
  value: bigint,
  prefix: bigint | undefined,
  length: number,
  width: bigint,
): boolean {
  if (prefix === undefined) {
    return false
  }
  const shift = width - BigInt(length)
  return value >> shift === prefix >> shift
}

function isInIpv4Range(value: bigint, range: readonly [string, number]): boolean {
  return isInPrefix(value, ipv4Value(range[0]), range[1], IPV4_BITS)
}

function isInIpv6Range(value: bigint, range: readonly [string, number]): boolean {
  return isInPrefix(value, ipv6Value(range[0]), range[1], IPV6_BITS)
}

function isPublicIpv4(value: bigint): boolean {
  return NON_PUBLIC_IPV4_RANGES.every((range) => !isInIpv4Range(value, range))
}

function isPublicIpv6(value: bigint): boolean {
  if (IPV6_EMBEDDED_IPV4_PREFIXES.some((range) => isInIpv6Range(value, range))) {
    return isPublicIpv4(value & IPV4_MASK)
  }
  return isInIpv6Range(value, IPV6_SIX_TO_FOUR)
    ? isPublicIpv4((value >> SIX_TO_FOUR_SHIFT) & IPV4_MASK)
    : isInIpv6Range(value, IPV6_GLOBAL_UNICAST) &&
        NON_PUBLIC_IPV6_RANGES.every((range) => !isInIpv6Range(value, range))
}

/** The address family of an IP address, or undefined for anything else (a name). */
export function addressFamily(address: string): AddressFamily | undefined {
  if (ipv4Value(address) !== undefined) {
    return ADDRESS_FAMILIES.ipv4
  }
  return ipv6Value(address) === undefined ? undefined : ADDRESS_FAMILIES.ipv6
}

/**
 * Whether the address is a public internet address. Anything that is not an
 * address at all, and any IPv6 address with a zone, is not.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Value(address)
  if (v4 !== undefined) {
    return isPublicIpv4(v4)
  }
  const v6 = ipv6Value(address)
  return v6 !== undefined && isPublicIpv6(v6)
}
