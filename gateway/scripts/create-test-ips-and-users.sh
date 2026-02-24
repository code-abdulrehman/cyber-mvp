#!/usr/bin/env bash
# Create local fake/test IPs and users; run a command with each IP (X-Forwarded-For).
# Usage:
#   ./create-test-ips-and-users.sh              # create/list IPs and users
#   ./create-test-ips-and-users.sh run -- <cmd> # run <cmd> with each IP (use {{IP}} or {{USER}} in cmd)
#   ./create-test-ips-and-users.sh ips           # print one IP per line
#   ./create-test-ips-and-users.sh users        # print one user per line

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_FILE="${SCRIPT_DIR}/.test-ips-and-users.json"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3001}"

# Default fake IPs and users (local testing only)
DEFAULT_IPS='["192.168.99.11","192.168.99.12","192.168.99.13","10.0.0.101","10.0.0.102"]'
DEFAULT_USERS='["testuser1","testuser2","testuser3","bot_alice","bot_bob"]'

create_data() {
  if [[ -f "$DATA_FILE" ]]; then
    echo "Test data already exists: $DATA_FILE"
    return 0
  fi
  printf '%s\n' "{
  \"ips\": $DEFAULT_IPS,
  \"users\": $DEFAULT_USERS,
  \"created\": \"$(TZ=UTC date +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%S")\"
}" > "$DATA_FILE"
  echo "Created $DATA_FILE with fake IPs and users."
}

read_json_array() {
  local key="$1"
  if command -v jq &>/dev/null; then
    jq -r ".${key}[]" "$DATA_FILE"
  else
    node -e "
      const fs=require('fs'), p=require('path');
      const f=p.join('$SCRIPT_DIR', '.test-ips-and-users.json');
      const d=JSON.parse(fs.readFileSync(f,'utf8'));
      (d.$key||[]).forEach(x=>console.log(x));
    "
  fi
}

list_data() {
  if [[ ! -f "$DATA_FILE" ]]; then
    create_data
  fi
  echo "IPs:"
  read_json_array ips
  echo ""
  echo "Users:"
  read_json_array users
}

print_ips() {
  if [[ ! -f "$DATA_FILE" ]]; then create_data; fi
  read_json_array ips
}

print_users() {
  if [[ ! -f "$DATA_FILE" ]]; then create_data; fi
  read_json_array users
}

run_with_ips() {
  if [[ ! -f "$DATA_FILE" ]]; then create_data; fi
  local ips
  ips=($(print_ips))
  local users
  users=($(print_users))
  local i=0
  for ip in "${ips[@]}"; do
    user="${users[$((i % ${#users[@]}))]}"
    export TEST_IP="$ip" TEST_USER="$user"
    # Replace {{IP}} and {{USER}} in the command
    cmd=("$@")
    args=()
    for arg in "${cmd[@]}"; do
      arg="${arg//\{\{IP\}\}/$ip}"
      arg="${arg//\{\{USER\}\}/$user}"
      args+=("$arg")
    done
    echo ">>> IP=$ip USER=$user"
    "${args[@]}"
    ((i++)) || true
  done
}

case "${1:-}" in
  run)
    shift
    if [[ "$1" == "--" ]]; then shift; fi
    if [[ $# -eq 0 ]]; then
      echo "Usage: $0 run -- <command> (use {{IP}} or {{USER}} in args)"
      echo "Example: $0 run -- curl -s -H 'X-Forwarded-For: {{IP}}' $GATEWAY_URL/api/users"
      exit 1
    fi
    run_with_ips "$@"
    ;;
  ips)
    print_ips
    ;;
  users)
    print_users
    ;;
  *)
    create_data
    list_data
    echo ""
    echo "Run a command with each IP: $0 run -- <cmd>"
    echo "Example: $0 run -- curl -s -H 'X-Forwarded-For: {{IP}}' $GATEWAY_URL/api/users"
    ;;
esac
