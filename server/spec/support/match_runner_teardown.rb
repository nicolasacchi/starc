# frozen_string_literal: true

# Teardown for example groups that let a real match start.
#
# Starting a match through the REST API (or adopting one) launches a tick
# thread that lives in `Starc::MatchRunner.registry` until it is stopped.
# `use_transactional_fixtures` rolls the `matches` row back, so SQLite hands
# the same id to the next example: an orphan thread that is still stepping
# broadcasts snapshots onto `game:<recycled id>` inside every later example
# that installs a fresh test pubsub adapter.
#
# This is opt-in — include it in the groups that start matches — because
# stopping every runner after every example in the suite would also stop the
# runners examples deliberately inspect while they are still live.
module MatchRunnerTeardown
  def self.included(base)
    base.after { stop_and_forget_match_runners! }
  end

  # No tick thread may outlive the example that adopted it, and the registry
  # must not hand a stopped runner to a later `adopt` on a recycled id.
  def stop_and_forget_match_runners!
    Starc::MatchRunner.stop_all!
    Starc::MatchRunner.all.each { |runner| Starc::MatchRunner.forget(runner.match_id) }
  end
end
