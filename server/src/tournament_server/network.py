from __future__ import annotations

import ipaddress
import socket

import psutil


class NoFreePortError(RuntimeError):
    pass


def find_free_port(host: str, start_port: int, max_tries: int = 11) -> int:
    """Tries binding a real socket to (host, port) for `max_tries`
    consecutive ports starting at `start_port`, returning the first free
    one. Raises NoFreePortError naming the full range if none are free."""
    last_port = start_port + max_tries - 1
    for port in range(start_port, last_port + 1):
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
            return port
        except OSError:
            continue
        finally:
            probe.close()

    raise NoFreePortError(
        f"no free port in {start_port}-{last_port} on {host}"
    )


def _is_loopback_or_link_local(address: str) -> bool:
    parsed = ipaddress.ip_address(address)
    return parsed.is_loopback or parsed.is_link_local


# Common virtual/container/VPN adapter name prefixes across Linux, macOS,
# and Windows — these carry valid private IPv4 addresses that pass the
# loopback/link-local check but are never the venue LAN interface a
# scorer tablet or Pi display would connect over.
_VIRTUAL_INTERFACE_PREFIXES = (
    "lo",
    "docker",
    "br-",
    "veth",
    "tun",
    "tap",
    "vmnet",
    "virbr",
    "utun",
    "ppp",
    "vboxnet",
    "zt",  # ZeroTier
)


def _is_likely_virtual_interface(name: str) -> bool:
    lowered = name.lower()
    return any(lowered.startswith(prefix) for prefix in _VIRTUAL_INTERFACE_PREFIXES)


def enumerate_lan_addresses() -> list[str]:
    """Returns this machine's own non-loopback, non-link-local IPv4
    addresses, excluding common virtual/container/VPN adapters by
    interface name (docker bridges, tun/tap, veth, etc.) — best-effort,
    can still include or miss an address on an unusual setup."""
    addresses: list[str] = []
    for interface_name, interface_addresses in psutil.net_if_addrs().items():
        if _is_likely_virtual_interface(interface_name):
            continue
        for addr in interface_addresses:
            if addr.family != socket.AF_INET:
                continue
            if _is_loopback_or_link_local(addr.address):
                continue
            if addr.address in addresses:
                continue
            addresses.append(addr.address)

    return addresses
