# frozen_string_literal: true

require "rails_helper"

RSpec.describe Replay do
  let(:match) { create(:match, name: "Replay Match", mode: "melee", map_id: "altaior", max_players: 2, seed: 555_555) }
  let(:commands) do
    [
      { "tick" => 0, "player_id" => 1, "index" => 0, "c" => "move", "ids" => [101, 102], "x" => 40.5, "y" => 12.25, "queue" => false },
      { "tick" => 7, "player_id" => 2, "index" => 1, "c" => "build", "ids" => [], "x" => -3, "y" => 0, "queue" => true }
    ]
  end
  let(:final_state) { { "entities" => [{ "id" => 101, "kind" => "marine", "x" => 1, "y" => 2 }], "tick" => 12 } }

  describe ".record!" do
    it "stores the match's replay header when none is supplied" do
      seat = match.add_player!(player: create(:player, name: "header_player"), ready: true)
      match.add_player!(player: create(:player), ready: true)
      match.start!
      seat.reload.update!(result: :win)

      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)

      expect(replay.parsed_header).to eq(match.replay_header.deep_stringify_keys)
      expect(replay.parsed_header["players"].first["name"]).to eq("header_player")
      expect(replay.parsed_header["winner"]).to be_nil
    end

    it "writes a starc format version 1 replay" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)

      expect(replay.version).to eq(1)
      expect(replay.format).to eq("starc")
      expect(replay.format_before_type_cast).to eq(described_class::FORMAT_STARC)
    end

    it "serialises the command stream and the final state into their text columns" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)

      expect(replay.header).to be_a(String)
      expect(replay.commands).to be_a(String)
      expect(replay.final_state).to be_a(String)
      expect(replay.reload.commands).to start_with("[")
      expect(JSON.parse(replay.reload.final_state)).to eq(final_state)
    end

    it "round-trips the exact command array it was given" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)

      expect(replay.parsed_commands).to eq(commands)
      expect(replay.reload.parsed_commands).to eq(commands)
    end

    it "preserves nested structures, floats and booleans through the round trip" do
      nested = [{ "c" => "queue", "queue" => [{ "c" => "move", "ids" => [1, 2, 3], "x" => 0.125, "y" => -9.75, "queue" => false }] }]
      replay = described_class.record!(match: match, commands: nested, final_state: {}, tick_count: 1)

      expect(replay.parsed_commands).to eq(nested)
    end

    it "derives command_count from the command list when it is not given" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)
      expect(replay.command_count).to eq(2)
    end

    it "honours an explicitly supplied command_count" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state,
                                            tick_count: 12, command_count: 2)
      expect(replay.command_count).to eq(2)
    end

    it "counts zero for an empty command stream" do
      replay = described_class.record!(match: match, commands: [], final_state: {}, tick_count: 0)
      expect(replay.command_count).to eq(0)
      expect(replay.tick_count).to eq(0)
      expect(replay.parsed_commands).to eq([])
    end

    it "stores the tick count it was handed" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 4_321)
      expect(replay.tick_count).to eq(4_321)
    end

    it "keeps the first replay when a second write is attempted for the same match" do
      first = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)

      expect {
        described_class.record!(match: match, commands: [{ "tick" => 99 }], final_state: {}, tick_count: 99)
      }.to raise_error(ActiveRecord::RecordInvalid)

      expect(described_class.where(match: match).count).to eq(1)
      expect(described_class.find(first.id).parsed_commands).to eq(commands)
    end
  end

  describe "validations" do
    it "requires a match that does not already have a replay" do
      described_class.record!(match: match, commands: [], final_state: {}, tick_count: 0)
      clash = build(:replay, match: match)
      expect(clash).not_to be_valid
      expect(clash.errors[:match_id]).to be_present
    end

    it "requires a positive version" do
      expect(build(:replay, match: match, version: 0)).not_to be_valid
      expect(build(:replay, match: match, version: 1)).to be_valid
    end

    it "requires header, commands and final state to be present" do
      %i[header commands final_state].each do |field|
        replay = build(:replay, match: match, field => "")
        expect(replay).not_to be_valid, "expected blank #{field} to be rejected"
        expect(replay.errors[field]).to include("can't be blank")
      end
    end

    it "refuses negative counters" do
      expect(build(:replay, match: match, command_count: -1)).not_to be_valid
      expect(build(:replay, match: match, tick_count: -1)).not_to be_valid
    end
  end

  describe "#to_replay_hash" do
    it "carries the PROTOCOL §8 envelope with the parsed payload inside" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)

      hash = replay.to_replay_hash

      expect(hash.keys).to contain_exactly(:format, :version, :header, :commands, :final_state)
      expect(hash[:format]).to eq("starc-replay")
      expect(hash[:version]).to eq(1)
      expect(hash[:commands]).to eq(commands)
      expect(hash[:final_state]).to eq(final_state)
      expect(hash[:header]).to eq(replay.parsed_header)
    end

    it "survives a full round trip through JSON" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)

      reloaded = JSON.parse(JSON.generate(replay.to_replay_hash))

      expect(reloaded["commands"]).to eq(commands)
      expect(reloaded["final_state"]).to eq(final_state)
      expect(reloaded["header"]).to eq(replay.parsed_header)
    end
  end

  describe "#to_download_hash" do
    it "matches the GET /matches/:id/replay payload from PROTOCOL §7" do
      replay = described_class.record!(match: match, commands: commands, final_state: final_state, tick_count: 12)

      hash = replay.to_download_hash

      expect(hash.keys).to contain_exactly(:header, :commands, :snapshots_meta, :replay_url)
      expect(hash[:commands]).to eq(commands)
      expect(hash[:header]).to eq(replay.parsed_header)
      expect(hash[:snapshots_meta]).to eq(tick_count: 12, command_count: 2, version: 1)
      expect(hash[:replay_url]).to eq("/api/v1/matches/#{match.id}/replay")
    end
  end

  describe "the recent_first scope" do
    it "returns the newest replay first" do
      older_match = create(:match)
      older = described_class.record!(match: older_match, commands: [], final_state: {}, tick_count: 1)
      newer = described_class.record!(match: match, commands: [], final_state: {}, tick_count: 1)

      expect(described_class.recent_first.first).to eq(newer)
      expect(described_class.recent_first.to_a).to include(older)
    end
  end

  describe "ActiveRecord#valid? is not shadowed" do
    it "keeps the inherited valid? so a validation context can still be passed" do
      expect(described_class.instance_method(:valid?).owner).not_to eq(described_class)

      replay = build(:replay, match: match)
      expect(replay.valid?(:create)).to be(true)
      expect { replay.save! }.to change(described_class, :count).by(1)
    end
  end
end
