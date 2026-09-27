# frozen_string_literal: true

FactoryBot.define do
  factory :player do
    sequence(:name) { |n| "player#{n}" }
    password { "hunter2" }
    password_confirmation { "hunter2" }

    trait :with_session do
      after(:create) { |player| player.issue_session!(ip: "127.0.0.1") }
    end
  end

  factory :session do
    player
    sequence(:token) { |n| "tok#{n}" * 8 }
    expires_at { 30.days.from_now }
    last_ip { "127.0.0.1" }
  end

  factory :match do
    sequence(:name) { |n| "Match #{n}" }
    mode { "melee" }
    map_id { "altaior" }
    max_players { 2 }
    sequence(:seed) { |n| 1_000_000 + n }
    status { :lobby }

    trait :in_progress do
      status { :in_progress }
      started_at { Time.current }
    end

    trait :finished do
      status { :finished }
      started_at { 1.hour.ago }
      ended_at { 30.minutes.ago }
      duration_ms { 1_800_000 }
    end
  end

  factory :match_player do
    match
    player
    slot { 0 }
    team { 1 }
    race { "terran" }
    host { false }
    ready { false }
    result { :pending }
  end

  factory :replay do
    match
    version { 1 }
    format { :starc }
    header { { "format" => "starc-replay", "version" => 1 }.to_json }
    commands { [].to_json }
    final_state { { "entities" => [] }.to_json }
    command_count { 0 }
    tick_count { 0 }
  end

  factory :leaderboard_entry do
    player
    mode { "melee" }
    race { "terran" }
    rating { 1200 }
  end
end
