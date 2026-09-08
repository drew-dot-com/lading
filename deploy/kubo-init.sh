#!/bin/sh
# Runs inside the kubo container on every start (container-init.d), after the
# repo exists and before the daemon: Lading's kubo is a pinning node with a
# read-only gateway for what it holds, not a public IPFS proxy.
set -e
IP="${LADING_PUBLIC_IP:-167.233.221.236}"
HOST="${LADING_IPFS_HOST:-ipfs.$(echo "$IP" | tr . -).sslip.io}"
# Serve only content this node already has: no fetching on behalf of strangers.
ipfs config --json Gateway.NoFetch true
ipfs config --json Gateway.PublicGateways "{\"$HOST\":{\"Paths\":[\"/ipfs\"],\"UseSubdomains\":false}}"
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
# Tell the DHT where we really are (docker publishes 4001 on the host).
ipfs config --json Addresses.AppendAnnounce "[\"/ip4/$IP/tcp/4001\",\"/ip4/$IP/udp/4001/quic-v1\"]"
# Re-announce what we pin, and only that.
ipfs config Reprovider.Strategy pinned
# A 4 GB box shared with the node stack: keep the swarm and memory modest.
ipfs config --json Swarm.ConnMgr '{"Type":"basic","LowWater":64,"HighWater":192,"GracePeriod":"30s"}'
ipfs config --json Swarm.ResourceMgr '{"Enabled":true,"MaxMemory":"512MiB"}'
echo "lading kubo config applied for $HOST"
