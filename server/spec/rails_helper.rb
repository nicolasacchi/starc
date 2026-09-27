# frozen_string_literal: true

require "spec_helper"
require "fileutils"

ENV["RAILS_ENV"] ||= "test"

# Give each rspec process its own SQLite file. `use_transactional_fixtures`
# holds a write transaction open for the whole example, so two processes
# sharing one database block each other — WAL does not help, because only one
# writer can exist at a time. `DATABASE_URL` pins a specific file, which is
# how the e2e suite points its spawned server at the same database.
#
# `storage/test-<pid>.sqlite3` is removed on exit so runs do not accumulate.
ENV["DATABASE_URL"] ||= "sqlite3:#{File.expand_path("../storage", __dir__)}/test-#{Process.pid}.sqlite3"

require_relative "../config/environment"
require "rspec/rails"

Dir[Rails.root.join("spec/support/**/*.rb")].sort.each { |f| require f }

begin
  ActiveRecord::Migration.maintain_test_schema!
rescue ActiveRecord::PendingMigrationError => e
  abort e.to_s.strip
end

at_exit { FileUtils.rm_f(Dir["#{__dir__}/../storage/test-*.sqlite3{,-shm,-wal}"]) }

RSpec.configure do |config|
  config.fixture_paths = [Rails.root.join("spec/fixtures")]
  config.use_transactional_fixtures = true
  config.infer_spec_type_from_file_location!
  config.filter_rails_from_backtrace!

  config.include FactoryBot::Syntax::Methods
  config.include ActiveSupport::Testing::TimeHelpers

  # `spec/e2e` boots a real Rails server on a real port, drives real WebSocket
  # clients through a whole match, and commits rows to the database — so it is
  # strictly opt-in, and the opt-in is explicit rather than inferred from the
  # file list. Run it with `STARC_E2E=1 bundle exec rspec` or
  # `bundle exec rspec spec/e2e`.
  e2e_requested = ENV["STARC_E2E"] == "1" || ARGV.any? { |a| a.include?("spec/e2e") }
  config.filter_run_excluding(e2e: true) unless e2e_requested
  config.define_derived_metadata(file_path: %r{/spec/e2e/}) { |meta| meta[:e2e] = true }

  # The simulation is deterministic; pin the global RNG per example so an
  # accidental dependency on it fails loudly instead of flaking.
  config.before(:each) { srand(RSpec.configuration.seed) }
end
