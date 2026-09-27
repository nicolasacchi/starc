# frozen_string_literal: true

require "rails_helper"

RSpec.describe MatchPlayer do
  let(:match) { create(:match, max_players: 8) }
  # Reads the column straight out of SQLite so the assertion is about what was
  # actually stored, not about ActiveRecord's enum casting.
  def stored_result(seat)
    ActiveRecord::Base.connection.select_value("SELECT result FROM match_players WHERE id = #{seat.id}")
  end


  describe "race" do
    it "accepts every race in the shared roster" do
      described_class::RACES.each do |race|
        seat = build(:match_player, match: match, player: create(:player), slot: described_class::RACES.index(race), race: race)
        expect(seat).to be_valid, "expected #{race} to be a playable race"
      end
    end

    it "rejects a race that is not in the roster and names it back" do
      seat = build(:match_player, match: match, player: create(:player), race: "orc")
      expect(seat).not_to be_valid
      expect(seat.errors[:race]).to include("orc is not a playable race")
    end

    it "rejects a missing race" do
      seat = build(:match_player, match: match, player: create(:player), race: nil)
      expect(seat).not_to be_valid
      expect(seat.errors[:race]).to include("can't be blank")
    end
  end

  describe "slot" do
    it "cannot be reused inside the same match" do
      create(:match_player, match: match, slot: 2)
      clash = build(:match_player, match: match, player: create(:player), slot: 2)

      expect(clash).not_to be_valid
      expect(clash.errors[:slot]).to include("already taken in this match")
    end

    it "is reusable across different matches" do
      create(:match_player, match: match, slot: 0)
      other = build(:match_player, match: create(:match, max_players: 8), player: create(:player), slot: 0)
      expect(other).to be_valid
    end

    it "must be a non-negative integer" do
      expect(build(:match_player, match: match, player: create(:player), slot: -1)).not_to be_valid
      expect(build(:match_player, match: match, player: create(:player), slot: nil)).not_to be_valid
    end
  end

  describe "one seat per player per match" do
    it "rejects a second seat for the same player in the same match" do
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0)
      clash = build(:match_player, match: match, player: player, slot: 1)

      expect(clash).not_to be_valid
      expect(clash.errors[:player_id]).to include("is already in this match")
    end

    it "lets the same player sit in a different match" do
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0)
      expect(build(:match_player, match: create(:match, max_players: 8), player: player, slot: 0)).to be_valid
    end
  end

  describe "team" do
    it "must be a positive integer" do
      expect(build(:match_player, match: match, player: create(:player), team: 0)).not_to be_valid
      expect(build(:match_player, match: match, player: create(:player), team: -1)).not_to be_valid
      expect(build(:match_player, match: match, player: create(:player), team: 1)).to be_valid
    end
  end

  describe "result" do
    it "maps pending/win/loss/draw to 0/1/2/3" do
      {
        pending: 0,
        win: 1,
        loss: 2,
        draw: 3
      }.each do |name, value|
        seat = create(:match_player, match: match, player: create(:player), slot: value, result: name)
        expect(seat.reload.result).to eq(name.to_s)
        expect(seat.public_send("#{name}?")).to be(true)
        expect(stored_result(seat)).to eq(value)
      end
    end

    it "rejects a result outside the enum" do
      seat = build(:match_player, match: match, player: create(:player), result: :surrendered)
      expect(seat).not_to be_valid
      expect(seat.errors[:result]).to be_present
    end
  end

  describe "per-match statistics" do
    it "refuses negative values" do
      %i[kills deaths units_built army_value].each do |field|
        seat = build(:match_player, match: match, player: create(:player), field => -1)
        expect(seat).not_to be_valid, "expected #{field} = -1 to be rejected"
        expect(seat.errors[field]).to include("must be greater than or equal to 0")
      end

      seat = build(:match_player, match: match, player: create(:player), resources_mined: -5)
      expect(seat).not_to be_valid
      expect(seat.errors[:resources_mined]).to include("must be greater than or equal to 0")
    end

    it "accepts a zeroed-out seat" do
      seat = build(:match_player, match: match, player: create(:player))
      expect(seat).to be_valid
    end
  end

  describe ".race_taken?" do
    it "is true for a race somebody is already playing" do
      create(:match_player, match: match, player: create(:player), race: "protoss")
      expect(described_class.race_taken?(match, "protoss")).to be(true)
    end

    it "is false for a race that is still free" do
      create(:match_player, match: match, player: create(:player), race: "protoss")
      expect(described_class.race_taken?(match, "zerg")).to be(false)
    end

    it "is false for a blank race" do
      expect(described_class.race_taken?(match, nil)).to be(false)
      expect(described_class.race_taken?(match, "")).to be(false)
    end

    it "only looks at the match it is given" do
      create(:match_player, match: match, player: create(:player), race: "zerg")
      other = create(:match, max_players: 8)
      expect(described_class.race_taken?(other, "zerg")).to be(false)
    end
  end

  describe "#next_free_race" do
    it "skips races that are taken" do
      create(:match_player, match: match, player: create(:player), race: "terran")
      seat = build(:match_player, match: match, player: create(:player))
      expect(seat.next_free_race).to eq("zerg")
    end

    it "skips the race the caller is switching away from" do
      seat = build(:match_player, match: match, player: create(:player))
      expect(seat.next_free_race("terran")).to eq("zerg")
    end

    it "falls back to the first race when every race is in use" do
      described_class::RACES.each_with_index do |race, index|
        create(:match_player, match: match, player: create(:player), slot: index, race: race)
      end
      seat = build(:match_player, match: match, player: create(:player))
      expect(seat.next_free_race).to eq(described_class::RACES.first)
    end
  end

  describe "#to_lobby_hash" do
    it "carries exactly the lobby fields with the seat's current values" do
      player = create(:player, name: "lobby_seat")
      seat = create(:match_player, match: match, player: player, slot: 3, race: "zerg",
                                    team: 2, host: true, ready: true)

      hash = seat.to_lobby_hash

      expect(hash.keys).to contain_exactly(:player_id, :name, :race, :ready, :is_host, :slot, :team)
      expect(hash[:player_id]).to eq(player.id)
      expect(hash[:name]).to eq("lobby_seat")
      expect(hash[:race]).to eq("zerg")
      expect(hash[:ready]).to be(true)
      expect(hash[:is_host]).to be(true)
      expect(hash[:slot]).to eq(3)
      expect(hash[:team]).to eq(2)
    end

    it "does not leak the password digest or the raw session tokens" do
      seat = create(:match_player, match: match, player: create(:player, :with_session))
      expect(seat.to_lobby_hash.keys).not_to include(:password_digest, :token, :id)
    end
  end

  describe "#to_score_hash" do
    it "carries exactly the score fields with the seat's statistics" do
      seat = create(:match_player, match: match, player: create(:player), slot: 1, race: "protoss",
                                    result: :win, kills: 9, deaths: 4, resources_mined: 1_500,
                                    units_built: 22, army_value: 640)

      hash = seat.to_score_hash

      expect(hash.keys).to contain_exactly(
        :player_id, :race, :result, :kills, :deaths, :resources_mined, :units_built, :army_value
      )
      expect(hash[:player_id]).to eq(seat.player_id)
      expect(hash[:race]).to eq("protoss")
      expect(hash[:result]).to eq("win")
      expect(hash[:kills]).to eq(9)
      expect(hash[:deaths]).to eq(4)
      expect(hash[:resources_mined]).to eq(1_500)
      expect(hash[:units_built]).to eq(22)
      expect(hash[:army_value]).to eq(640)
    end

    it "reports an unfinished seat as a draw so the scoreboard always has a result" do
      seat = create(:match_player, match: match, player: create(:player), result: :pending)
      expect(seat).to be_pending
      expect(seat.to_score_hash[:result]).to eq("draw")
    end

    it "reports a real draw as a draw" do
      seat = create(:match_player, match: match, player: create(:player), result: :draw)
      expect(seat.to_score_hash[:result]).to eq("draw")
    end

    it "reports a loss as a loss" do
      seat = create(:match_player, match: match, player: create(:player), result: :loss)
      expect(seat.to_score_hash[:result]).to eq("loss")
    end
  end

  describe "the ordered scope" do
    it "returns the seats in slot order regardless of insertion order" do
      slots = [3, 0, 2, 1].map { |slot| create(:match_player, match: match, player: create(:player), slot: slot) }

      expect(match.match_players.ordered.to_a).to eq(slots.sort_by(&:slot))
    end
  end

  describe "ActiveRecord#valid? is not shadowed" do
    it "keeps the inherited valid? so a validation context can still be passed" do
      expect(described_class.instance_method(:valid?).owner).not_to eq(described_class)

      seat = build(:match_player, match: match, player: create(:player))
      expect(seat.valid?(:create)).to be(true)
      expect { seat.save! }.to change(described_class, :count).by(1)
    end
  end
end
