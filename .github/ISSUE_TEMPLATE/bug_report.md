---
name: Bug Report
about: Something is not working as expected
---

**Crucible version:** (check package.json or service logs)
**OS and version:** (e.g., Ubuntu 24.04)
**Kernel:** (output of `uname -r`)
**Node.js version:** (output of `node --version`)
**Running as root:** yes/no

**What happened:**

**What you expected:**

**Service status:**
```
systemctl status glassmkr-crucible
```

**Last 50 log lines:**
```
journalctl -u glassmkr-crucible -n 50 --no-pager
```
