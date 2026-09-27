# frozen_string_literal: true

require "rails_helper"

RSpec.describe Player do
  describe "name normalisation" do
    it "stores the stripped name rather than the padded one" do
      player = create(:player, name: "  Nik  ")
      expect(player.reload.name).to eq("Nik")
    end
  end

  describe "name validation" do
    it "rejects a name shorter than 3 characters" do
      player = build(:player, name: "ab")
      expect(player).not_to be_valid
      expect(player.errors[:name]).to include("is too short (minimum is 3 characters)")
    end

    it "accepts exactly 3 and exactly 24 characters but not 2 or 25" do
      expect(build(:player, name: "abc")).to be_valid
      expect(build(:player, name: "a" * 24)).to be_valid
      expect(build(:player, name: "a" * 25)).not_to be_valid
    end

    it "rejects names containing characters outside [A-Za-z0-9_-]" do
      %w[with\ space quote'name plus+name emoji😀 dot.name].each do |bad|
        player = build(:player, name: bad)
        expect(player).not_to be_valid, "expected #{bad.inspect} to be rejected"
        expect(player.errors[:name]).to include("is invalid")
      end
    end

    it "accepts names built from the allowed alphabet" do
      expect(build(:player, name: "nik-01_A")).to be_valid
    end

    it "treats names differing only in case as duplicates" do
      create(:player, name: "Commander")
      clash = build(:player, name: "commander")
      expect(clash).not_to be_valid
      expect(clash.errors[:name]).to include("has already been taken")
    end

    it "strips before checking duplicates, so padding cannot smuggle in a taken name" do
      create(:player, name: "Commander")
      clash = build(:player, name: "  commander  ")
      expect(clash).not_to be_valid
      expect(clash.errors[:name]).to include("has already been taken")
    end
  end

  describe "password" do
    it "rejects a password shorter than 6 characters" do
      player = build(:player, password: "12345", password_confirmation: "12345")
      expect(player).not_to be_valid
      expect(player.errors[:password]).to include("is too short (minimum is 6 characters)")
    end

    it "rejects a confirmation that does not match, so the intended password can never be set" do
      player = build(:player, password: "hunter2", password_confirmation: "hunter3")
      expect(player).not_to be_valid
    end

    it "authenticates the right password and refuses a wrong one" do
      player = create(:player, password: "hunter2")
      expect(player.authenticate("hunter2")).to be_truthy
      expect(player.authenticate("hunter3")).to be(false)
      expect(player.authenticate("")).to be(false)
    end

    it "stores a bcrypt digest, never the plaintext" do
      player = create(:player, password: "hunter2")
      expect(player.password_digest).to match(/\A\$2[aby]\$\d{2}\$/)
      expect(player.password_digest).not_to include("hunter2")
    end
  end

  describe "#issue_session!" do
    it "persists a session row belonging to the player" do
      player = create(:player)
      session = nil
      expect { session = player.issue_session!(ip: "10.0.0.9") }.to change(Session, :count).by(1)
      expect(session).to be_a(Session)
      expect(session.player_id).to eq(player.id)
      expect(session.last_ip).to eq("10.0.0.9")
    end

    it "issues a 43 character urlsafe token" do
      session = create(:player).issue_session!
      expect(session.token).to match(/\A[A-Za-z0-9_-]{43}\z/)
    end

    it "expires 30 days out" do
      session = create(:player).issue_session!
      expect(session.expires_at).to be_within(1.minute).of(30.days.from_now)
    end

    it "issues a different token on every call" do
      player = create(:player)
      tokens = Array.new(20) { player.issue_session!.token }
      expect(tokens.uniq.size).to eq(20)
    end

    it "never hands two players the same token" do
      first = create(:player).issue_session!
      second = create(:player).issue_session!
      expect(first.token).not_to eq(second.token)
    end
  end

  describe "token storage" do
    it "keeps auth tokens in the sessions table, not mirrored on the player row" do
      expect(Player.column_names).not_to include("token")
      expect(Player.column_names).not_to include("token_expires_at")

      player = create(:player, :with_session)
      expect(player.reload.attributes).not_to have_key("token")
      expect(player.sessions.pluck(:token)).to all(match(/\A[A-Za-z0-9_-]{43}\z/))
    end
  end

  describe "#active_session?" do
    it "is true while a session is live" do
      player = create(:player, :with_session)
      expect(player.active_session?).to be(true)
    end

    it "is false once every session has expired" do
      player = create(:player, :with_session)
      player.sessions.update_all(expires_at: 1.hour.ago)
      expect(player.active_session?).to be(false)
    end

    it "is false for a brand new player" do
      expect(create(:player).active_session?).to be(false)
    end
  end

  describe "#record_result!" do
    let(:player) { create(:player, wins: 2, losses: 1, draws: 3) }

    it "increments wins alone for a win" do
      player.record_result!(result: "win")
      player.reload
      expect([player.wins, player.losses, player.draws]).to eq([3, 1, 3])
    end

    it "increments losses alone for a loss" do
      player.record_result!(result: "loss")
      player.reload
      expect([player.wins, player.losses, player.draws]).to eq([2, 2, 3])
    end

    it "increments draws alone for a draw" do
      player.record_result!(result: "draw")
      player.reload
      expect([player.wins, player.losses, player.draws]).to eq([2, 1, 4])
    end

    it "records the per-match statistics alongside the outcome" do
      player.record_result!(result: "win", kills: 12, deaths: 5, resources_mined: 4_200, units_built: 31)
      player.reload
      expect(player.kills).to eq(12)
      expect(player.deaths).to eq(5)
      expect(player.resources_mined).to eq(4_200)
      expect(player.units_built).to eq(31)
    end

    it "raises on an unknown result and leaves every counter untouched" do
      expect { player.record_result!(result: "surrender") }.to raise_error(ArgumentError, /unknown result/)
      player.reload
      expect([player.wins, player.losses, player.draws]).to eq([2, 1, 3])
    end

    it "rejects negative statistics" do
      expect { player.record_result!(result: "win", kills: -1) }.to raise_error(ActiveRecord::RecordInvalid)
    end
  end

  describe "#rating" do
    it "starts at the base rating with no games played" do
      player = create(:player)
      expect(player.rating).to eq(1200)
      expect(player.matches_played).to eq(0)
    end

    it "rises on a win" do
      player = create(:player)
      player.record_result!(result: "win")
      expect(player.reload.rating).to be > 1200
    end

    it "falls on a loss" do
      player = create(:player)
      player.record_result!(result: "loss")
      expect(player.reload.rating).to be < 1200
    end

    it "ignores draws when computing the rating but counts them as games played" do
      player = create(:player)
      player.record_result!(result: "draw")
      player.reload
      expect(player.rating).to eq(1200)
      expect(player.matches_played).to eq(1)
    end
  end

  describe "ActiveRecord#valid? is not shadowed" do
    it "keeps the inherited valid? so a validation context can still be passed and save works" do
      expect(described_class.instance_method(:valid?).owner).not_to eq(described_class)

      player = build(:player)
      # A zero-arity override raises ArgumentError here, and breaks `save`.
      expect(player.valid?(:create)).to be(true)
      expect { player.save! }.to change(described_class, :count).by(1)
    end
  end
end
