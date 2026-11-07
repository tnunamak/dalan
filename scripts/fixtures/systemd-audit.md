# Isolated systemd audit container

A privileged systemd container can acquire a host console and disrupt the host login session. This harness never uses privileged mode or host devices. The image masks console services before startup, and the launcher inspects each created container before starting its immutable ID.

Build only the adjacent reviewed `systemd-audit.Dockerfile`, which masks the console units. Save the immutable image ID returned by that build with the audit evidence, then pass that ID to `node scripts/systemd-audit-container.mjs IMAGE_ID`. The launcher rejects mutable tags, missing IDs and containers whose inspected image differs from that ID. An arbitrary pre-existing image ID does not establish that console masks are present; retain the Dockerfile revision, build command and image ID together.

The fixed container configuration uses private cgroup, process and IPC namespaces, private temporary filesystems and no host mounts or device mappings. It adds only `SYS_ADMIN` because the test image runs systemd as PID 1. Inspection refuses privileged mode, interactive TTYs, all device mappings, unexpected mounts, published ports and malformed configuration. Failed inspection or startup removes only the exact ID created by that invocation, including when startup acknowledgement is lost.

Run `node --test scripts/systemd-container-safety-test.mjs` to check these decisions without Docker. These tests do not prove that a systemd service starts on this host. If the nonprivileged configuration cannot start because the host denies cgroup setup, record the live test as untested; do not add privileged mode, bind the host cgroup filesystem, or map console devices.

After an admitted run, stop and remove only the owned container ID and remove the owned image when it is no longer needed. Never remove containers by a broad name pattern.
