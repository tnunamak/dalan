FROM node:24-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus-user-session git gh curl procps util-linux ca-certificates \
  && systemctl --root=/ mask getty.target console-getty.service getty@tty1.service serial-getty@.service getty@.service autovt@.service \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1500 --shell /bin/bash bridge \
  && install -d -o bridge -g bridge -m 0700 /home/bridge/.config /home/bridge/.local/share \
  && install -d -o root -g root -m 0755 /var/lib/systemd/linger \
  && touch /var/lib/systemd/linger/bridge \
  && chmod 0644 /var/lib/systemd/linger/bridge
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
