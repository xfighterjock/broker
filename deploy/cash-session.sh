#!/usr/bin/env bash
# US cash-session clock for deploy logs.
# Weekdays 09:30 inclusive through 16:00 exclusive, America/New_York.
# This is the clock window only. It is not the NYSE holiday or early-close calendar.

cash_session_read() {
  local dow hm stamp
  CASH_SESSION_KIND=""
  CASH_SESSION_LABEL=""
  stamp="$(TZ=America/New_York date '+%u %H%M %A %Y-%m-%d %H:%M %Z')" || return 1
  read -r dow hm CASH_SESSION_LABEL <<< "$stamp"
  if ! [[ "$dow" =~ ^[1-7]$ ]] || ! [[ "$hm" =~ ^[0-9]{4}$ ]]; then
    echo "Unexpected America/New_York clock: ${stamp}" >&2
    return 1
  fi
  # 10# forces decimal. 0930 is not an octal number.
  if [ "$dow" -le 5 ] && [ "$((10#$hm))" -ge 930 ] && [ "$((10#$hm))" -lt 1600 ]; then
    CASH_SESSION_KIND=in
  else
    CASH_SESSION_KIND=out
  fi
}

log_cash_session() {
  cash_session_read || return 1
  if [ "$CASH_SESSION_KIND" = "in" ]; then
    echo "::warning title=US cash session::Clock is ${CASH_SESSION_LABEL}. Deploy is proceeding during the market cash session (weekday 09:30–16:00 America/New_York). systemctl restart event-gate will briefly stop the process. This deploy is allowed."
  else
    echo "Outside the US cash session (weekday 09:30–16:00 America/New_York). Clock is ${CASH_SESSION_LABEL}."
  fi
}
