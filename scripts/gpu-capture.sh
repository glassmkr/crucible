#!/usr/bin/env bash
#
# gpu-capture.sh: one-shot telemetry capture for a borrowed multi-GPU box.
#
# WHY THIS EXISTS. Four of the six open questions from the 2026-08-02 GPU research
# can only be answered on real NVLink hardware, and our own GPU host is a single
# L4 with no NVLink at all. If we get temporary access to an 8xH200 NVL or 8xB300
# box, we get one attempt. The expensive failure is running a partial probe, giving
# the machine back, and only then discovering we needed one more field.
#
# So this captures EVERYTHING relevant, raw, with exit codes and stderr preserved,
# sampled repeatedly so counter behaviour is observable, into one tarball to take
# home and analyse offline.
#
# READ-ONLY BY DEFAULT. Every command below only reads. Nothing resets a counter,
# changes a setting, or touches a running job. The optional --with-sudo re-runs the
# same read-only set as root to answer "does this actually need privilege", which
# is open question 4 and is not answerable from documentation.
#
# WHAT IT ANSWERS
#   Q3  are the byte counters monotonic, and what is their epoch
#   Q4  which reads genuinely need root on this driver and OS image
#   Q5  how counters behave over time (and across a reset, if the owner permits one)
#   Q1  whether NCCL RAS is listening and reachable
#   Q2  which SXid surfaces actually exist on this platform
#
# USAGE
#   ./gpu-capture.sh                          # 6 samples, 30s apart, unprivileged
#   ./gpu-capture.sh --samples 12 --interval 60
#   ./gpu-capture.sh --with-sudo              # also capture a root pass, for Q4
#   ./gpu-capture.sh --label before-reset     # then again with --label after-reset
#
# To answer Q5 properly, if the owner allows it: run once with --label pre, have
# them reload the driver or reset a GPU, then run again with --label post. Do NOT
# do that yourself on a borrowed machine.

set -u

SAMPLES=6
INTERVAL=30
WITH_SUDO=0
LABEL="capture"

while [ $# -gt 0 ]; do
  case "$1" in
    --samples)  SAMPLES="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --with-sudo) WITH_SUDO=1; shift ;;
    --label)    LABEL="$2"; shift 2 ;;
    -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="gpu-capture-${LABEL}-${STAMP}"
mkdir -p "$OUT/samples" "$OUT/static" "$OUT/sudo" || exit 1

echo "[capture] writing to $OUT"
echo "[capture] $SAMPLES samples at ${INTERVAL}s intervals"

# Run a command, preserving stdout, stderr and exit code separately. The exit code
# and stderr ARE the capability data: an empty stdout means nothing on its own, and
# distinguishing "not supported" from "permission denied" from "unknown field" is
# the entire point of collecting this.
cap() {
  local dir="$1" name="$2"; shift 2
  {
    echo "### cmd: $*"
    echo "### utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$dir/$name.meta"
  "$@" > "$dir/$name.out" 2> "$dir/$name.err"
  echo "### exit: $?" >> "$dir/$name.meta"
}

capfile() {
  local dir="$1" name="$2" path="$3"
  if [ -r "$path" ]; then
    cp "$path" "$dir/$name" 2>/dev/null || echo "UNREADABLE" > "$dir/$name"
  else
    echo "ABSENT_OR_UNREADABLE: $path" > "$dir/$name"
  fi
}

# ---------------------------------------------------------------------------
# Static: identity, topology, environment. Captured once.
# ---------------------------------------------------------------------------
echo "[capture] static context"
cap "$OUT/static" hostname          hostname -f
cap "$OUT/static" uname             uname -a
cap "$OUT/static" os-release        cat /etc/os-release
cap "$OUT/static" lspci-nvidia      sh -c "lspci -nnvv | grep -iA24 nvidia"
cap "$OUT/static" lspci-all         lspci -nn
cap "$OUT/static" nvidia-smi        nvidia-smi
cap "$OUT/static" nvidia-smi-q      nvidia-smi -q
cap "$OUT/static" nvidia-smi-q-all  nvidia-smi -q -d ALL
cap "$OUT/static" topo-m            nvidia-smi topo -m
cap "$OUT/static" topo-matrix       nvidia-smi topo --matrix
cap "$OUT/static" gpu-csv           nvidia-smi --query-gpu=index,name,uuid,pci.bus_id,driver_version,vbios_version,serial,inforom.img --format=csv
cap "$OUT/static" driver-modinfo    modinfo nvidia
capfile "$OUT/static" boot_id       /proc/sys/kernel/random/boot_id
capfile "$OUT/static" driver-version /proc/driver/nvidia/version

# Fabric manager and NVSwitch. B300 only; on H200 NVL these should all come back
# absent, and that negative is itself a result worth recording.
echo "[capture] fabric manager and nvswitch"
cap "$OUT/static" fm-status         systemctl status nvidia-fabricmanager
cap "$OUT/static" fm-show           systemctl show nvidia-fabricmanager
cap "$OUT/static" fm-version        nv-fabricmanager --version
cap "$OUT/static" nvswitch-smi      nvidia-smi nvswitch -q
cap "$OUT/static" nvswitch-audit    nvswitch-audit
cap "$OUT/static" nscq-present      sh -c "ldconfig -p | grep -i nscq"
cap "$OUT/static" fm-log-tail       sh -c "tail -400 /var/log/fabricmanager.log"

# DCGM, if the owner happens to have it. We do not install anything.
echo "[capture] dcgm, if present"
cap "$OUT/static" dcgmi-discovery   dcgmi discovery -l
cap "$OUT/static" dcgmi-health      dcgmi health -g 0 -c
cap "$OUT/static" nv-hostengine     sh -c "pgrep -a nv-hostengine"

# NCCL RAS: open question 1. Default port 28028 since NCCL 2.24.
echo "[capture] nccl ras probe"
cap "$OUT/static" ncclras-which     sh -c "command -v ncclras"
cap "$OUT/static" ncclras-query     ncclras
cap "$OUT/static" port-28028        sh -c "ss -lntp 2>/dev/null | grep -E '28028|LISTEN' | head -40"
cap "$OUT/static" nccl-version      sh -c "python3 -c 'import torch;print(torch.cuda.nccl.version())' 2>/dev/null || ldconfig -p | grep -i nccl"

# RDMA / InfiniBand / RoCE endpoint surface.
echo "[capture] rdma endpoints"
cap "$OUT/static" ibstat            ibstat
cap "$OUT/static" ibstatus          ibstatus
cap "$OUT/static" ibv-devinfo       ibv_devinfo -v
cap "$OUT/static" ip-link           ip -d link show
cap "$OUT/static" rdma-link         rdma link show
cap "$OUT/static" ib-sysfs-tree     sh -c "find /sys/class/infiniband -maxdepth 4 2>/dev/null | head -400"
for d in /sys/class/infiniband/*/; do
  [ -d "$d" ] || continue
  dev=$(basename "$d")
  cap "$OUT/static" "ibcounters-$dev" sh -c "grep -r . ${d}ports/*/counters/ 2>/dev/null"
  cap "$OUT/static" "ibhw-$dev"       sh -c "grep -r . ${d}ports/*/hw_counters/ 2>/dev/null"
done
for n in $(ls /sys/class/net 2>/dev/null); do
  case "$n" in lo|docker*|veth*|virbr*) continue ;; esac
  cap "$OUT/static" "ethtool-$n"    ethtool -S "$n"
done

# Kernel log: Xid and SXid. Open question 2 (does SXid exist on this platform).
echo "[capture] kernel xid and sxid"
cap "$OUT/static" dmesg-nvrm        sh -c "dmesg -T 2>/dev/null | grep -iE 'nvrm|xid|sxid|nvswitch|nvlink' | tail -600"
cap "$OUT/static" journal-nvrm      sh -c "journalctl -k --no-pager --since '-30 days' 2>/dev/null | grep -iE 'nvrm|xid|sxid|nvswitch|nvlink' | tail -600"

# ---------------------------------------------------------------------------
# Repeated samples: this is what makes counter behaviour observable.
# A single reading cannot tell you whether a counter is cumulative, whether it
# moves at all, or whether it ever goes backwards.
# ---------------------------------------------------------------------------
GPUS=$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | tr -d ' ')
echo "[capture] gpus detected: $(echo "$GPUS" | grep -c . || echo 0) (indices: $(echo "$GPUS" | tr '\n' ' '))"

i=1
while [ "$i" -le "$SAMPLES" ]; do
  d="$OUT/samples/$(printf '%03d' "$i")"
  mkdir -p "$d"
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" > "$d/timestamp"
  echo "[capture] sample $i/$SAMPLES"

  cap "$d" nvlink-status-all  nvidia-smi nvlink -s
  cap "$d" nvlink-errors-all  nvidia-smi nvlink -e
  cap "$d" fabric-q           sh -c "nvidia-smi -q | grep -iA30 -E 'fabric|nvlink'"
  cap "$d" ecc-q              sh -c "nvidia-smi -q -d ECC"
  cap "$d" nvswitch-q         nvidia-smi nvswitch -q

  for g in $GPUS; do
    # -s state, -e errors, -ec per-lane CRC/ECC (NVLink 4), -p remote PCI function,
    # -R remote device + remote link id, -gt throughput counters.
    # -p and -R are the authoritative peer-identity surface and are what the
    # research says to key link-loss detection on, rather than a topo hash.
    cap "$d" "nvlink-s-gpu$g"   nvidia-smi nvlink -s  -i "$g"
    cap "$d" "nvlink-e-gpu$g"   nvidia-smi nvlink -e  -i "$g"
    cap "$d" "nvlink-ec-gpu$g"  nvidia-smi nvlink -ec -i "$g"
    cap "$d" "nvlink-p-gpu$g"   nvidia-smi nvlink -p  -i "$g"
    cap "$d" "nvlink-R-gpu$g"   nvidia-smi nvlink -R  -i "$g"
    cap "$d" "nvlink-gt-d-gpu$g" nvidia-smi nvlink -gt d -i "$g"
    cap "$d" "nvlink-gt-p-gpu$g" nvidia-smi nvlink -gt p -i "$g"
    cap "$d" "nvlink-gt-r-gpu$g" nvidia-smi nvlink -gt r -i "$g"
  done

  for dd in /sys/class/infiniband/*/; do
    [ -d "$dd" ] || continue
    dev=$(basename "$dd")
    cap "$d" "ibcounters-$dev" sh -c "grep -r . ${dd}ports/*/counters/ 2>/dev/null"
  done

  [ "$i" -lt "$SAMPLES" ] && sleep "$INTERVAL"
  i=$((i + 1))
done

# ---------------------------------------------------------------------------
# Optional root pass: answers "does this actually need privilege on this image".
# Same read-only commands, nothing mutating.
# ---------------------------------------------------------------------------
if [ "$WITH_SUDO" -eq 1 ]; then
  echo "[capture] repeating a subset as root to test the privilege question"
  cap "$OUT/sudo" nvlink-status  sudo -n nvidia-smi nvlink -s
  cap "$OUT/sudo" nvlink-errors  sudo -n nvidia-smi nvlink -e
  cap "$OUT/sudo" nvlink-gt-d    sudo -n nvidia-smi nvlink -gt d
  cap "$OUT/sudo" nvidia-smi-q   sudo -n nvidia-smi -q
  cap "$OUT/sudo" nvswitch-q     sudo -n nvidia-smi nvswitch -q
  cap "$OUT/sudo" dmesg          sudo -n sh -c "dmesg -T | grep -iE 'xid|sxid|nvlink|nvswitch' | tail -400"
  cap "$OUT/sudo" mlxlink-list   sudo -n sh -c "for m in \$(ls /dev/mst 2>/dev/null); do echo \"== \$m\"; mlxlink -d /dev/mst/\$m -m -e -c 2>&1 | head -60; done"
fi

# ---------------------------------------------------------------------------
{
  echo "capture_label=$LABEL"
  echo "captured_utc=$STAMP"
  echo "samples=$SAMPLES"
  echo "interval_seconds=$INTERVAL"
  echo "with_sudo=$WITH_SUDO"
  echo "whoami=$(whoami)"
  echo "gpu_count=$(echo "$GPUS" | grep -c . || echo 0)"
} > "$OUT/MANIFEST"

tar czf "$OUT.tar.gz" "$OUT" 2>/dev/null && echo "[capture] done: $OUT.tar.gz"
echo "[capture] bring that tarball home; nothing here is destructive and nothing was reset"
