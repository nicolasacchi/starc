# frozen_string_literal: true

require "rails_helper"

RSpec.describe Match do
  # Reads the column straight out of SQLite so the assertion is about what was
  # actually stored, not about ActiveRecord's enum casting.
  def stored_status(model)
    ActiveRecord::Base.connection.select_value("SELECT status FROM matches WHERE id = #{model.id}")
  end

  def seat(match, slot)
    match.match_players.find_by!(slot: slot)
  end

  describe "status" do
    {
      lobby: 0,
      in_progress: 1,
      finished: 2,
      abandoned: 3
    }.each do |name, value|
      it "stores #{name} as status #{value}" do
        match = create(:match, status: name, ended_at: Time.current)
        expect(match.reload.status).to eq(name.to_s)
        expect(match.public_send("#{name}?")).to be(true)
        expect(stored_status(match)).to eq(value)
      end
    end

    it "is not joinable once it is running" do
      match = create(:match, :in_progress)
      expect(match).not_to be_joinable
      expect(described_class.joinable).not_to include(match)
    end

    it "is not joinable once it is finished" do
      match = create(:match, :finished)
      expect(match).not_to be_joinable
      expect(described_class.joinable).not_to include(match)
    end

    it "is not joinable once it is abandoned" do
      match = create(:match, status: :abandoned, ended_at: Time.current)
      expect(match).not_to be_joinable
      expect(described_class.joinable).not_to include(match)
    end
  end

  describe "validations" do
    it "requires a name" do
      match = build(:match, name: nil)
      expect(match).not_to be_valid
      expect(match.errors[:name]).to include("can't be blank")
    end

    it "rejects a name longer than 64 characters" do
      expect(build(:match, name: "x" * 65)).not_to be_valid
      expect(build(:match, name: "x" * 64)).to be_valid
    end

    it "only accepts the four protocol modes" do
      described_class::MODES.each { |mode| expect(build(:match, mode: mode)).to be_valid }
      expect(build(:match, mode: "battle_royale")).not_to be_valid
    end

    it "rejects a blank map" do
      match = build(:match, map_id: "   ")
      expect(match).not_to be_valid
      expect(match.errors[:map_id]).to include("can't be blank")
    end

    it "rejects a map that is not in the shared map data" do
      match = build(:match, map_id: "atlantis")
      expect(match).not_to be_valid
      expect(match.errors[:map_id]).to include("is not a known map")
    end

    it "accepts every map the shared data knows about" do
      Starc::Maps.ids.each { |id| expect(build(:match, map_id: id)).to be_valid }
    end

    it "keeps max_players between 2 and 8" do
      expect(build(:match, max_players: 1)).not_to be_valid
      expect(build(:match, max_players: 9)).not_to be_valid
      expect(build(:match, max_players: 2)).to be_valid
      expect(build(:match, max_players: 8)).to be_valid
    end

    it "requires a non-negative seed" do
      expect(build(:match, seed: -1)).not_to be_valid
      expect(build(:match, seed: 0)).to be_valid
    end

    it "requires an end time once the match is over" do
      %i[finished abandoned].each do |status|
        match = build(:match, status: status, ended_at: nil)
        expect(match).not_to be_valid, "expected #{status} without ended_at to be rejected"
        expect(match.errors[:ended_at]).to include("can't be blank")
      end
    end
  end

  describe "#add_player!" do
    let(:match) { create(:match, max_players: 4) }

    it "makes the first arrival the host and nobody after them" do
      first = match.add_player!(player: create(:player))
      second = match.add_player!(player: create(:player))
      third = match.add_player!(player: create(:player))

      expect([first.host?, second.host?, third.host?]).to eq([true, false, false])
      expect(match.reload.host_player).to eq(first.player)
      expect(match.host_match_player.slot).to eq(first.slot)
    end

    it "hands the host flag to an explicitly designated host even if they arrive second" do
      match.add_player!(player: create(:player), host: false)
      designated = match.add_player!(player: create(:player), host: true)

      expect(designated.host?).to be(true)
      expect(match.reload.match_players.where(host: true).pluck(:id)).to contain_exactly(designated.id)
    end

    it "fills the lowest free slot first" do
      slots = Array.new(3) { match.add_player!(player: create(:player)).slot }
      expect(slots).to eq([0, 1, 2])
    end

    it "reuses the slot of a player who left" do
      a = match.add_player!(player: create(:player))
      b = match.add_player!(player: create(:player))
      c = match.add_player!(player: create(:player))
      expect([a.slot, b.slot, c.slot]).to eq([0, 1, 2])

      match.remove_player!(b.player)
      replacement = match.add_player!(player: create(:player))

      expect(replacement.slot).to eq(1)
    end

    it "hands out distinct playable races while any race is still free" do
      races = Array.new(3) { match.add_player!(player: create(:player)).race }
      expect(races).to eq(%w[terran zerg protoss])
    end

    it "honours an explicitly requested race" do
      seat = match.add_player!(player: create(:player), race: "zerg")
      expect(seat.race).to eq("zerg")
    end

    it "refuses to add past capacity" do
      full = create(:match, max_players: 2)
      full.add_player!(player: create(:player))
      full.add_player!(player: create(:player))

      expect(full).to be_full
      expect { full.add_player!(player: create(:player)) }
        .to raise_error(ArgumentError, "match is full")
      expect(full.match_players.count).to eq(2)
    end

    it "refuses the same player twice, before the match is even full" do
      player = create(:player)
      match.add_player!(player: player)

      expect { match.add_player!(player: player) }
        .to raise_error(ArgumentError, "player is already in this match")
      expect(match.match_players.count).to eq(1)
    end

    it "refuses a race it does not know" do
      expect { match.add_player!(player: create(:player), race: "orc") }
        .to raise_error(ActiveRecord::RecordInvalid)
    end
  end

  describe "#player_count" do
    it "counts the seats in the database, not a cached association" do
      match = create(:match, max_players: 2)
      match.add_player!(player: create(:player))
      match.add_player!(player: create(:player))

      # Prime the association cache: `size` would answer from this array and
      # `player_count` has to answer from the database instead.
      match.match_players.load
      expect(match.match_players.size).to eq(2)

      match.remove_player!(match.host_player)

      expect(match.player_count).to eq(1)
      expect(match).not_to be_full
      expect(match).to be_joinable
    end

    it "stays correct after an addition too" do
      match = create(:match, max_players: 4)
      match.add_player!(player: create(:player))
      match.match_players.load

      match.add_player!(player: create(:player))

      expect(match.player_count).to eq(2)
    end
  end

  describe "#remove_player!" do
    let(:match) { create(:match, max_players: 4) }

    it "hands the host flag to the lowest remaining slot" do
      host = match.add_player!(player: create(:player))
      second = match.add_player!(player: create(:player))
      third = match.add_player!(player: create(:player))

      match.remove_player!(host.player)

      expect(second.reload.host?).to be(true)
      expect(third.reload.host?).to be(false)
      expect(match.host_player).to eq(second.player)
    end

    it "leaves the host alone when a non-host leaves" do
      host = match.add_player!(player: create(:player))
      other = match.add_player!(player: create(:player))

      match.remove_player!(other.player)

      expect(host.reload.host?).to be(true)
      expect(match.host_player).to eq(host.player)
    end

    it "destroys the seat" do
      seat = match.add_player!(player: create(:player))
      expect { match.remove_player!(seat.player) }.to change(MatchPlayer, :count).by(-1)
      expect(match.reload.match_players).to be_empty
    end

    it "returns nil for somebody who never joined" do
      expect(match.remove_player!(create(:player))).to be_nil
    end

    it "leaves an emptied match with nobody in it" do
      match.add_player!(player: create(:player))
      match.add_player!(player: create(:player))
      match.match_players.load

      match.remove_player!(match.host_player)
      match.remove_player!(match.host_player)

      expect(match.player_count).to eq(0)
      expect(match.match_players.reload).to be_empty
    end

    it "lets an emptied match be retired as abandoned instead of lingering in the lobby" do
      match.add_player!(player: create(:player))
      match.remove_player!(match.host_player)

      expect(match.player_count).to eq(0)
      match.update!(status: :abandoned, ended_at: Time.current)

      expect(match.reload).to be_abandoned
      expect(described_class.joinable).not_to include(match)
    end
  end

  describe "#joinable?" do
    it "is true in the lobby while there is room" do
      match = create(:match, max_players: 2)
      expect(match).to be_joinable
      match.add_player!(player: create(:player))
      expect(match).to be_joinable
    end

    it "is false once the match is full" do
      match = create(:match, max_players: 2)
      match.add_player!(player: create(:player))
      match.add_player!(player: create(:player))
      expect(match).to be_full
      expect(match).not_to be_joinable
    end
  end

  describe "#all_ready?" do
    it "needs at least two players" do
      match = create(:match, max_players: 4)
      match.add_player!(player: create(:player), ready: true)
      expect(match).not_to be_all_ready

      match.add_player!(player: create(:player), ready: true)
      expect(match).to be_all_ready
    end

    it "is false while a single seat has not readied up" do
      match = create(:match, max_players: 4)
      match.add_player!(player: create(:player), ready: true)
      match.add_player!(player: create(:player), ready: false)

      expect(match).not_to be_all_ready
      expect(match).not_to be_startable
    end
  end

  describe "#default_team" do
    it "puts everybody on their own team in melee" do
      match = create(:match, mode: "melee", max_players: 4)
      teams = Array.new(4) { match.add_player!(player: create(:player)).team }
      expect(teams).to eq([1, 1, 1, 1])
      expect(match.team_count).to eq(1)
    end

    it "alternates 1/2 in a team mode" do
      match = create(:match, mode: "team", max_players: 4)
      teams = Array.new(4) { match.add_player!(player: create(:player)).team }
      expect(teams).to eq([1, 2, 1, 2])
      expect(match.team_count).to eq(2)
    end
  end

  describe "#start!" do
    it "refuses to start a match that is not ready" do
      match = create(:match, max_players: 2)
      match.add_player!(player: create(:player), ready: true)

      expect { match.start! }.to raise_error(ArgumentError, "not startable")
      expect(match.reload).to be_lobby
    end

    it "moves a ready lobby match into in_progress and stamps started_at" do
      match = create(:match, max_players: 2)
      match.add_player!(player: create(:player), ready: true)
      match.add_player!(player: create(:player), ready: true)

      match.start!(started_at: 5.minutes.ago)

      expect(match.reload).to be_in_progress
      expect(match.started_at).to be_within(1.second).of(5.minutes.ago)
      expect(match).not_to be_joinable
    end
  end

  describe "#finish!" do
    let(:started_at) { Time.utc(2026, 9, 27, 10, 0, 0) }
    let(:match) { create(:match, :in_progress, started_at: started_at) }
    let(:winner) { create(:player) }

    it "records the outcome, the reason, the end time and the duration" do
      match.finish!(winner_player_id: winner.id, reason: "forfeit", ended_at: started_at + 60)

      match.reload
      expect(match).to be_finished
      expect(match.winner_player_id).to eq(winner.id)
      expect(match.end_reason).to eq("forfeit")
      expect(match.ended_at).to eq(started_at + 60)
      expect(match.duration_ms).to eq(60_000)
    end

    it "keeps an explicitly supplied duration" do
      match.finish!(winner_player_id: winner.id, reason: "win", duration_ms: 1_800_000)

      expect(match.reload.duration_ms).to eq(1_800_000)
    end
  end

  describe "#authenticate" do
    it "refuses everything when the match has no password" do
      expect(create(:match).authenticate("")).to be(false)
      expect(create(:match).authenticate("anything")).to be(false)
    end

    it "accepts the match password and nothing else" do
      match = create(:match, password_digest: BCrypt::Password.create("swordfish"))
      expect(match.authenticate("swordfish")).to be_truthy
      expect(match.authenticate("swordfis")).to be(false)
    end
  end

  describe "#to_summary_hash" do
    it "carries exactly the protocol fields with the current values" do
      match = create(:match, name: "Alpha Strike", mode: "team", map_id: "chokepoint", max_players: 4, seed: 4242)
      host = match.add_player!(player: create(:player, name: "hostplayer"), ready: true)

      summary = match.to_summary_hash

      expect(summary.keys).to contain_exactly(
        :id, :name, :mode, :map_id, :max_players, :player_count, :status, :has_password, :host
      )
      expect(summary[:id]).to eq(match.id)
      expect(summary[:name]).to eq("Alpha Strike")
      expect(summary[:mode]).to eq("team")
      expect(summary[:map_id]).to eq("chokepoint")
      expect(summary[:max_players]).to eq(4)
      expect(summary[:player_count]).to eq(1)
      expect(summary[:status]).to eq("lobby")
      expect(summary[:has_password]).to be(false)
      expect(summary[:host]).to eq("hostplayer")
      expect(host.player_id).to be_positive
    end

    it "reports the host as an empty string for an empty match" do
      expect(create(:match).to_summary_hash[:host]).to eq("")
    end

    it "reports a password-protected match as password protected" do
      match = create(:match, password_digest: BCrypt::Password.create("swordfish"))
      expect(match.to_summary_hash[:has_password]).to be(true)
    end
  end

  describe "#to_detail_hash" do
    it "is the summary plus one lobby entry per seat, ordered by slot" do
      match = create(:match, max_players: 4)
      a = match.add_player!(player: create(:player, name: "aaa"), ready: true)
      b = match.add_player!(player: create(:player, name: "bbb"))

      detail = match.to_detail_hash

      expect(detail.keys).to contain_exactly(
        :id, :name, :mode, :map_id, :max_players, :player_count, :status, :has_password, :host, :players
      )
      expect(detail[:players]).to eq([a.reload.to_lobby_hash, b.reload.to_lobby_hash])
      expect(detail[:players].map { |p| p[:slot] }).to eq([0, 1])
      expect(detail[:players].map { |p| p[:name] }).to eq(%w[aaa bbb])
    end

    it "lists an empty match with no players" do
      expect(create(:match).to_detail_hash[:players]).to eq([])
    end
  end

  describe "#players_ordered" do
    it "returns the seats in slot order" do
      match = create(:match, max_players: 4)
      slots = Array.new(3) { match.add_player!(player: create(:player)).slot }

      expect(match.players_ordered.map(&:slot)).to eq(slots.sort)
    end
  end

  describe "#replay_header" do
    it "carries the match facts and one row per seat as PROTOCOL §8 describes" do
      match = create(:match, name: "Header Test", mode: "melee", map_id: "altaior", max_players: 2, seed: 99_999)
      winner = match.add_player!(player: create(:player, name: "winner"), ready: true)
      loser = match.add_player!(player: create(:player, name: "loser"), ready: true)
      match.start!(started_at: Time.utc(2026, 9, 27, 10, 0, 0))
      winner.update!(result: :win)
      loser.update!(result: :loss)
      match.finish!(winner_player_id: winner.player_id, reason: "win", duration_ms: 456_150)

      header = match.replay_header

      expect(header[:match_id]).to eq(match.id)
      expect(header[:map_id]).to eq("altaior")
      expect(header[:seed]).to eq(99_999)
      expect(header[:mode]).to eq("melee")
      expect(header[:started_at]).to eq("2026-09-27T10:00:00Z")
      expect(header[:duration_ms]).to eq(456_150)
      expect(header[:winner]).to eq(winner.player_id)
      expect(header[:players]).to eq([
        { player_id: winner.player_id, name: "winner", race: winner.race, team: 1, result: "win" },
        { player_id: loser.player_id, name: "loser", race: loser.race, team: 1, result: "loss" }
      ])
    end

    it "reports a seat that never finished as a draw" do
      match = create(:match, max_players: 2)
      seat = match.add_player!(player: create(:player))
      expect(seat.reload).to be_pending
      expect(match.replay_header[:players].first[:result]).to eq("draw")
    end

    it "reports zero duration and no winner for a match that never started" do
      match = create(:match, max_players: 2)
      match.add_player!(player: create(:player))

      header = match.replay_header
      expect(header[:started_at]).to be_nil
      expect(header[:duration_ms]).to eq(0)
      expect(header[:winner]).to be_nil
    end
  end

  describe "ActiveRecord#valid? is not shadowed" do
    it "keeps the inherited valid? so a validation context can still be passed" do
      expect(described_class.instance_method(:valid?).owner).not_to eq(described_class)

      match = build(:match)
      expect(match.valid?(:create)).to be(true)
      expect { match.save! }.to change(described_class, :count).by(1)
    end
  end
end
