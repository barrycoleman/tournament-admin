from __future__ import annotations


class PluginError(Exception):
    """Base class for all plugin-registry errors."""


class PluginLoadError(PluginError):
    """Raised when a plugin's manifest or module can't be loaded/validated."""


class PluginInstallError(PluginError):
    """Raised when a plugin zip upload is malformed or invalid."""


class PluginAlreadyExistsError(PluginInstallError):
    """Raised when installing a plugin whose name is already installed."""
