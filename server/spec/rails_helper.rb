# frozen_string_literal: true

require "spec_helper"

ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"

abort("The Rails environment is running in production mode!") if Rails.env.production?

require "rspec/rails"

Dir[Rails.root.join("spec/support/**/*.rb")].sort.each { |f| require f }

begin
  ActiveRecord::Migration.maintain_test_schema!
rescue ActiveRecord::PendingMigrationError => e
  abort e.to_s.strip
end

RSpec.configure do |config|
  config.fixture_paths = [Rails.root.join("spec/fixtures")]
  config.use_transactional_fixtures = true
  config.infer_spec_type_from_file_location!
  config.filter_rails_from_backtrace!

  config.include FactoryBot::Syntax::Methods
  config.include ActiveSupport::Testing::TimeHelpers

  # `spec/e2e` boots a real Rails server on a real port and drives real
  # WebSocket clients through a full match. It is slow and needs a free port,
  # so it is opt-in: `bundle exec rspec spec/e2e`.
  config.filter_run_excluding(e2e: true) unless config.files_to_run.one? { |f| f.start_with?("spec/e2e") }
  config.define_derived_metadata(file_path: %r{/spec/e2e/}) { |meta| meta[:e2e] = true }

  # The simulation is deterministic; pin the global RNG per example so an
  # accidental dependency on it fails loudly instead of flaking.
  config.before(:each) { srand(RSpec.configuration.seed) }
end
