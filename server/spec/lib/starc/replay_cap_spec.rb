# frozen_string_literal: true

require "rails_helper"

# A replay is a promise that the recorded commands reproduce the match, and a
# match is bounded in time but not in input: `game:command` has no rate limit,
# so the recording used to grow for as long as the match ran — the runner's 256
# bounds a batch, not a match — and `finalize!` then serialised all of it into
# one `text` column.
#
# The bound has to be honest: a replay that quietly dropped the tail of a real
# match would read as a complete one and silently fail to reproduce
# `final_state`.
RSpec.describe Starc::ReplayWriter do
  let(:match) { create(:match, :in_progress) }
  subject(:writer) { described_class.new(match) }

  def record(index, tick: index)
    writer.record(tick: tick, player_id: 1, index: index, command: { "c" => "move", "ids" => [index] })
  end

  def finalize
    writer.finalize!(winner: 2, duration_ms: 1_000, tick_count: 10, final_state: { "entities" => [] })
  end

  it "keeps every command of a match that stays inside the cap" do
    described_class::MAX_COMMANDS.times { |n| record(n) }

    expect(writer.command_count).to eq(described_class::MAX_COMMANDS)
    expect(writer).not_to be_truncated
  end

  it "stops growing at the cap instead of following the match for 90 minutes" do
    (described_class::MAX_COMMANDS + 5_000).times { |n| record(n) }

    expect(writer.command_count).to eq(described_class::MAX_COMMANDS)
    expect(writer).to be_truncated
  end

  it "refuses the command that crosses the cap, and says so in the replay header" do
    (described_class::MAX_COMMANDS + 1).times { |n| record(n) }

    replay = finalize

    expect(replay.parsed_header).to include("command_count" => described_class::MAX_COMMANDS,
                                            "truncated" => true)
    expect(replay.parsed_commands.size).to eq(described_class::MAX_COMMANDS)
    expect(replay.command_count).to eq(described_class::MAX_COMMANDS)
  end

  it "labels a complete replay as complete, so a reader can tell the two apart" do
    3.times { |n| record(n) }

    replay = finalize

    expect(replay.parsed_header).to include("command_count" => 3, "truncated" => false)
  end

  it "keeps the commands it did record, in order, with their stamps" do
    described_class::MAX_COMMANDS.times { |n| record(n, tick: n + 1) }
    (described_class::MAX_COMMANDS + 10).times { |n| record(n, tick: n + 1) }

    replay = finalize
    first = replay.parsed_commands.first
    last = replay.parsed_commands.last

    expect(first).to include("c" => "move", "tick" => 1, "player_id" => 1, "index" => 0)
    expect(last["index"]).to eq(described_class::MAX_COMMANDS - 1)
  end
end
