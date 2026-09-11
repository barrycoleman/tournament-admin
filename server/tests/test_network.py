from __future__ import annotations

import socket
import types

import psutil
import pytest

from tournament_server.network import (
    NoFreePortError,
    _is_likely_virtual_interface,
    enumerate_lan_addresses,
    find_free_port,
)


def _fake_addr(address: str, family=socket.AF_INET):
    return types.SimpleNamespace(
        family=family, address=address, netmask=None, broadcast=None, ptp=None
    )


def test_find_free_port_returns_start_port_when_free():
    # Bind to port 0 first to get a genuinely unused port from the OS,
    # then release it immediately so find_free_port can claim it.
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    free_port = probe.getsockname()[1]
    probe.close()

    result = find_free_port("127.0.0.1", free_port, max_tries=11)

    assert result == free_port


def test_find_free_port_skips_occupied_port():
    occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    occupied.bind(("127.0.0.1", 0))
    occupied.listen(1)
    start_port = occupied.getsockname()[1]

    try:
        result = find_free_port("127.0.0.1", start_port, max_tries=11)
        # Only start_port itself is occupied, so the next port up is the
        # first one that should succeed.
        assert result == start_port + 1
    finally:
        occupied.close()


def test_find_free_port_raises_when_all_tries_exhausted():
    sockets = []
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        start_port = probe.getsockname()[1]
        probe.close()

        for offset in range(11):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", start_port + offset))
            s.listen(1)
            sockets.append(s)

        with pytest.raises(NoFreePortError) as exc_info:
            find_free_port("127.0.0.1", start_port, max_tries=11)

        assert str(start_port) in str(exc_info.value)
        assert str(start_port + 10) in str(exc_info.value)
    finally:
        for s in sockets:
            s.close()


def _is_excluded(address: str) -> bool:
    from tournament_server.network import _is_loopback_or_link_local

    return _is_loopback_or_link_local(address)


def test_is_loopback_or_link_local_excludes_loopback_and_link_local():
    addresses = [
        "127.0.0.1",
        "169.254.1.5",
        "192.168.1.10",
        "10.0.0.5",
    ]

    filtered = [a for a in addresses if not _is_excluded(a)]

    assert filtered == ["192.168.1.10", "10.0.0.5"]


def test_enumerate_lan_addresses_returns_a_list_of_strings():
    addresses = enumerate_lan_addresses()

    assert isinstance(addresses, list)
    assert all(isinstance(a, str) for a in addresses)
    assert "127.0.0.1" not in addresses


@pytest.mark.parametrize(
    "name",
    [
        "docker0",
        "br-5115c3c6064d",
        "veth0eb7074",
        "tun0",
        "tap0",
        "vmnet1",
        "virbr0",
        "utun3",
        "ppp0",
        "vboxnet0",
        "zt7nnydz6t",
    ],
)
def test_is_likely_virtual_interface_matches_known_prefixes(name):
    assert _is_likely_virtual_interface(name) is True


@pytest.mark.parametrize(
    "name",
    [
        "enx8cae4cdeac07",
        "eth0",
        "wlp0s20f3",
        "en0",
        "Wi-Fi",
        "lo",
        "Local Area Connection",
    ],
)
def test_is_likely_virtual_interface_does_not_match_real_adapters(name):
    assert _is_likely_virtual_interface(name) is False


def test_enumerate_lan_addresses_includes_windows_local_area_connection(monkeypatch):
    # Regression test for the "lo" prefix bug: a "startswith" match
    # against a tuple containing "lo" would also match Windows' classic
    # "Local Area Connection" friendly adapter name, silently emptying
    # the address list on exactly the machine that most needs it.
    fake_interfaces = {
        "Local Area Connection": [_fake_addr("192.168.1.50")],
    }
    monkeypatch.setattr(psutil, "net_if_addrs", lambda: fake_interfaces)

    addresses = enumerate_lan_addresses()

    assert addresses == ["192.168.1.50"]


def test_find_free_port_clamps_range_near_max_port_instead_of_overflowing():
    # start_port near 65535 with a max_tries that would otherwise probe
    # past 65535 must clamp the range rather than let socket.bind()
    # raise OverflowError (not an OSError subclass) once the computed
    # port number leaves the valid 0-65535 range.
    sockets = []
    try:
        for port in range(65525, 65536):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                s.listen(1)
                sockets.append(s)
            except OSError:
                s.close()

        with pytest.raises(NoFreePortError) as exc_info:
            find_free_port("127.0.0.1", 65530, max_tries=20)

        assert "65535" in str(exc_info.value)
    finally:
        for s in sockets:
            s.close()


@pytest.mark.parametrize("start_port", [0, -1, 65536, 70000])
def test_find_free_port_raises_cleanly_for_out_of_range_start_port(start_port):
    with pytest.raises(NoFreePortError):
        find_free_port("127.0.0.1", start_port, max_tries=11)


def test_find_free_port_raises_cleanly_for_non_positive_max_tries():
    with pytest.raises(NoFreePortError):
        find_free_port("127.0.0.1", 8000, max_tries=0)


def test_enumerate_lan_addresses_excludes_docker_and_vpn_interfaces_by_name(monkeypatch):
    # Reproduces this project's own dev machine: real LAN address on a
    # named ethernet adapter, alongside docker bridges, a docker veth
    # pair, and an active VPN tunnel — all valid private-range IPv4
    # addresses that plain loopback/link-local filtering would not catch.
    fake_interfaces = {
        "lo": [_fake_addr("127.0.0.1")],
        "docker0": [_fake_addr("172.17.0.1")],
        "br-5115c3c6064d": [_fake_addr("172.18.0.1")],
        "veth0eb7074": [_fake_addr("172.19.0.5")],
        "tun0": [_fake_addr("172.31.1.130")],
        "enx8cae4cdeac07": [_fake_addr("192.168.68.90")],
        "wlp0s20f3": [_fake_addr("192.168.68.42")],
    }
    monkeypatch.setattr(psutil, "net_if_addrs", lambda: fake_interfaces)

    addresses = enumerate_lan_addresses()

    assert sorted(addresses) == ["192.168.68.42", "192.168.68.90"]


def test_enumerate_lan_addresses_ignores_non_ipv4_families(monkeypatch):
    fake_interfaces = {
        "eth0": [
            _fake_addr("192.168.1.20"),
            _fake_addr("fe80::1", family=socket.AF_INET6),
        ],
    }
    monkeypatch.setattr(psutil, "net_if_addrs", lambda: fake_interfaces)

    addresses = enumerate_lan_addresses()

    assert addresses == ["192.168.1.20"]
