---
name: No Data in Forge
about: Crucible is running but Forge shows no data
---

**Crucible version:**
**OS and version:**
**How long since install:**

**Can you reach Forge?**
```
curl -s -o /dev/null -w "%{http_code}" https://forge.glassmkr.com/api/health
```

**Service status:**
```
systemctl status glassmkr-crucible
```

**Last 50 log lines:**
```
journalctl -u glassmkr-crucible -n 50 --no-pager
```

**Is smartctl installed?** `which smartctl`
**Is ipmitool installed?** `which ipmitool`
