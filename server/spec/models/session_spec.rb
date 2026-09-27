# frozen_string_literal: true

require "rails_helper"

RSpec.describe Session do
  describe "#active?" do
    it "is active before the expiry" do
      session = create(:session, expires_at: 1.hour.from_now)
      expect(session.active?).to be(true)
    end

    it "is inactive once the expiry has passed" do
      session = create(:session, expires_at: 1.hour.from_now)
      travel_to 2.hours.from_now do
        expect(session.active?).to be(false)
      end
    end

    it "is inactive for a session created already expired" do
      expect(create(:session, expires_at: 1.minute.ago).active?).to be(false)
    end
  end

  describe "#expire!" do
    it "kills the session and persists the new expiry" do
      session = create(:session, expires_at: 1.hour.from_now)
      session.expire!
      expect(session.active?).to be(false)
      expect(session.reload.expires_at).to be <= Time.current
      expect(described_class.live).not_to include(session)
    end

    it "returns the session so it can be chained" do
      session = create(:session, expires_at: 1.hour.from_now)
      expect(session.expire!).to be(session)
    end

    it "leaves an already expired session expired" do
      session = create(:session, expires_at: 2.hours.ago)
      session.expire!
      expect(session.active?).to be(false)
      expect(session.reload.expires_at).to be <= Time.current
    end
  end

  describe "the live scope" do
    it "returns sessions that have not expired and excludes the rest" do
      live = create(:session, expires_at: 1.hour.from_now)
      dead = create(:session, expires_at: 1.hour.ago)

      expect(described_class.live).to include(live)
      expect(described_class.live).not_to include(dead)
      expect(described_class.live).to contain_exactly(live)
    end

    it "treats a session expiring exactly now as live" do
      freeze = Time.current
      session = create(:session, expires_at: freeze)
      travel_to freeze do
        expect(described_class.live).to include(session)
        expect(session.active?).to be(false)
      end
    end
  end

  describe "Player#expire_sessions!" do
    it "deletes only the expired sessions and keeps the live ones" do
      player = create(:player)
      live = create(:session, player: player, expires_at: 1.hour.from_now)
      dead = create(:session, player: player, expires_at: 1.hour.ago)

      player.expire_sessions!

      expect(player.sessions.reload).to contain_exactly(live)
      expect(player.active_session?).to be(true)
    end

    it "leaves another player's sessions alone" do
      mine = create(:player)
      theirs = create(:player, :with_session)

      mine.issue_session!
      mine.sessions.update_all(expires_at: 1.hour.ago)
      mine.expire_sessions!

      expect(theirs.sessions.reload.count).to eq(1)
      expect(theirs.active_session?).to be(true)
    end
  end

  describe "validations" do
    it "requires a token" do
      session = build(:session, token: nil)
      expect(session).not_to be_valid
      expect(session.errors[:token]).to include("can't be blank")
    end

    it "requires the token to be unique across every player" do
      create(:session, token: "shared-token")
      clash = build(:session, token: "shared-token", player: create(:player))
      expect(clash).not_to be_valid
      expect(clash.errors[:token]).to include("has already been taken")
    end

    it "requires an expiry" do
      session = build(:session, expires_at: nil)
      expect(session).not_to be_valid
      expect(session.errors[:expires_at]).to include("can't be blank")
    end

    it "requires a player" do
      session = build(:session, player: nil)
      expect(session).not_to be_valid
      expect(session.errors[:player]).to be_present
    end
  end

  describe "ActiveRecord#valid? is not shadowed" do
    # `valid?` is a predicate taking an optional context argument; a model that
    # overrides it as a plain predicate breaks `save` for every caller.
    it "keeps the inherited valid? and answers liveness through #active?" do
      expect(described_class.instance_method(:valid?).owner).not_to eq(described_class)

      session = build(:session, expires_at: 1.hour.from_now)
      expect(session.valid?(:create)).to be(true)
      expect { session.save! }.to change(described_class, :count).by(1)
      expect(session).to be_active
    end
  end
end
