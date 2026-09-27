# frozen_string_literal: true

require "rails_helper"

# PROTOCOL.md §8: a replay is deterministic, so the recorded command stream has
# to be exactly the stream the world accepted — stamped, in order, and never
# rewriteable by a caller afterwards.
RSpec.describe Starc::ReplayWriter do
  subject(:writer) { described_class.new(match) }

  let(:match) { create(:match, :in_progress) }

  def wire_move(ids: [101], **rest)
    { "c" => "move", "ids" => ids, "x" => 40.5, "z" => 12.25, "queue" => false }.merge(rest.transform_keys(&:to_s))
  end

  describe "#record" do
    it "stamps the entry with the tick, the player and the batch index" do
      entry = writer.record(tick: 840, player_id: 7, index: 3, command: wire_move)

      expect(entry["tick"]).to eq(840)
      expect(entry["player_id"]).to eq(7)
      expect(entry["index"]).to eq(3)
    end

    it "coerces the stamp to integers, so a string id cannot reach the replay" do
      entry = writer.record(tick: "840", player_id: "7", index: "3", command: wire_move)

      expect(entry["tick"]).to eq(840)
      expect(entry["player_id"]).to eq(7)
      expect(entry["index"]).to eq(3)
    end

    it "merges the command hash verbatim, keeping every field the client sent" do
      command = wire_move(queue: true, extra_note: "hi")

      entry = writer.record(tick: 1, player_id: 7, index: 0, command: command)

      expect(entry["c"]).to eq("move")
      expect(entry["ids"]).to eq([101])
      expect(entry["x"]).to eq(40.5)
      expect(entry["z"]).to eq(12.25)
      expect(entry["queue"]).to be(true)
      expect(entry["extra_note"]).to eq("hi")
    end

    it "records exactly the stamp plus the command's own keys, nothing invented" do
      entry = writer.record(tick: 1, player_id: 7, index: 0, command: { "c" => "stop", "ids" => [5] })

      expect(entry.keys.sort).to eq(%w[c ids index player_id tick])
    end

    it "does not let a client-supplied index clobber the recorded batch position" do
      # A hostile client could add `index: 0` to its command hash; the replay
      # has to answer with the position the command actually occupied.
      entry = writer.record(tick: 5, player_id: 7, index: 4, command: wire_move(index: 0, tick: 999_999))

      expect(entry["index"]).to eq(4)
      expect(entry["tick"]).to eq(5)
    end

    it "does not let a client-supplied player_id or tick rewrite the stamp" do
      entry = writer.record(tick: 5, player_id: 7, index: 0,
                            command: { "c" => "stop", "ids" => [1], "player_id" => 99, "tick" => 1 })

      expect(entry["player_id"]).to eq(7)
      expect(entry["tick"]).to eq(5)
    end

    it "accepts a command with symbol keys and stringifies them" do
      entry = writer.record(tick: 1, player_id: 7, index: 0, command: { c: "stop", ids: [5] })

      expect(entry["c"]).to eq("stop")
      expect(entry["ids"]).to eq([5])
    end
  end

  describe "#commands" do
    it "preserves the order the commands were recorded in" do
      writer.record(tick: 1, player_id: 7, index: 0, command: { "c" => "stop", "n" => "first" })
      writer.record(tick: 2, player_id: 8, index: 1, command: { "c" => "stop", "n" => "second" })
      writer.record(tick: 3, player_id: 7, index: 2, command: { "c" => "stop", "n" => "third" })

      expect(writer.commands.map { |c| c["n"] }).to eq(%w[first second third])
    end

    it "is empty for a writer nobody has written to" do
      expect(writer.commands).to eq([])
      expect(writer.command_count).to eq(0)
    end

    it "hands out a copy, so mutating the result cannot corrupt the recording" do
      writer.record(tick: 1, player_id: 7, index: 0, command: { "c" => "move", "ids" => [101] })

      taken = writer.commands
      entry = taken.first
      taken.clear
      entry["c"] = "attack"
      entry["ids"] = [999]

      expect(writer.command_count).to eq(1)
      expect(writer.commands.first["c"]).to eq("move")
      expect(writer.commands.first["ids"]).to eq([101])
    end

    it "counts every accepted command" do
      3.times { |i| writer.record(tick: i, player_id: 7, index: i, command: { "c" => "stop", "ids" => [1] }) }

      expect(writer.command_count).to eq(3)
    end
  end

  describe "#finalize!" do
    it "writes a replay carrying the recorded commands" do
      writer.record(tick: 1, player_id: 7, index: 0, command: { "c" => "stop", "ids" => [5] })

      replay = writer.finalize!(winner: 7, duration_ms: 1000, tick_count: 20,
                               final_state: { "entities" => [] })

      expect(replay).to be_persisted
      expect(replay.match_id).to eq(match.id)
      expect(replay.tick_count).to eq(20)
      expect(replay.command_count).to eq(1)
      expect(JSON.parse(replay.commands).first).to include("tick" => 1, "player_id" => 7, "c" => "stop")
    end

    it "stamps the header with the winner and the duration" do
      match.update!(status: :in_progress)
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0, team: 1, race: "terran", host: true)
      match.update!(status: :in_progress, started_at: Time.current)

      replay = writer.finalize!(winner: player.id, duration_ms: 4321, tick_count: 9,
                                final_state: { "entities" => [] })
      header = JSON.parse(replay.header)

      expect(header["winner"]).to eq(player.id)
      expect(header["duration_ms"]).to eq(4321)
      expect(header["seed"]).to eq(match.seed)
    end

    it "keeps the first replay when finalised twice, rather than writing a second row" do
      first = writer.finalize!(winner: nil, duration_ms: 10, tick_count: 1, final_state: { "entities" => [] })
      second = writer.finalize!(winner: nil, duration_ms: 99, tick_count: 9, final_state: { "entities" => [] })

      expect(Replay.where(match_id: match.id).count).to eq(1)
      expect(second.id).to eq(first.id)
      expect(JSON.parse(second.header)["duration_ms"]).to eq(10)
    end
  end
end
