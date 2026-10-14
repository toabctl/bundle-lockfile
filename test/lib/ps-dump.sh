#!/bin/sh
# Every process: pid, state, the kernel function it waits in, command line (for a command that hangs: run.cjs)
date
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  state=$(sed -n 's/^State:[[:space:]]*//p' "$p/status" 2>/dev/null)
  wchan=$(cat "$p/wchan" 2>/dev/null)
  args=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null | cut -c1-200)
  [ -n "$args" ] && printf '%s %s %s %s\n' "$pid" "$state" "${wchan:--}" "$args"
done
