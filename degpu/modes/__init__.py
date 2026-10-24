"""Verification modes: the off-chain drivers of each market contract (see ``base.py``).

``PROVIDER_DRIVERS[mode]`` and ``CLIENT_DRIVERS[mode]`` are the driver classes the provider agent
and the client use for jobs of that mode. A new mode adds its market contract, a module here with
its two drivers, and one line in each dict.
"""

from degpu.modes.checked import CheckedClient, CheckedProvider
from degpu.modes.replicated import ReplicatedClient, ReplicatedProvider

PROVIDER_DRIVERS = {"replicated": ReplicatedProvider, "checked": CheckedProvider}
CLIENT_DRIVERS = {"replicated": ReplicatedClient, "checked": CheckedClient}
