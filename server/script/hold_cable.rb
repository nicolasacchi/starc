#!/usr/bin/env ruby
# frozen_string_literal: true

# Holds one authenticated ActionCable connection open for a given player so a
# browser client can be screenshotted mid-match without the opponent's
# disconnect ending it. Dev/demo helper only.
#
#   bin/rails runner script/hold_cable.rb <player_name> <match_id> [seconds]

require_relative "../spec/support/websocket_client"
require_relative "../spec/support/cable_client"

name = ARGV[0] or abort("usage: hold_cable.rb <player_name> <match_id> [seconds]")
match_id = Integer(ARGV[1])
seconds = Integer(ARGV[2] || "600")

player = Player.find_by!(name: name)
token = player.issue_session!.token
base = ENV.fetch("BASE_URL", "http://127.0.0.1:3000")

client = CableClient.open(base, token: token, label: "hold-#{name}")
client.subscribe({ "channel" => "GameChannel", "match_id" => match_id })
# No await_confirmation here: the client already holds messages until the
# server confirms, and the confirm frame can arrive before we start looking.
client.send_message({ "channel" => "GameChannel", "match_id" => match_id },
                    { "v" => 1, "t" => "identify", "token" => token })

warn "[hold_cable] #{name} (player #{player.id}) holding game:#{match_id} for #{seconds}s"
deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + seconds
count = 0
while Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
  begin
    client.messages(timeout: 1.0)
    count += 1
  rescue StandardError => e
    warn "[hold_cable] #{e.class}: #{e.message}"
  end
end
client.close
warn "[hold_cable] released after ~#{count} frames"
