# frozen_string_literal: true

require "socket"
require "timeout"

# Boots a real Rails server on an ephemeral port for the end-to-end suite and
# tears it down afterwards. The e2e tests drive two genuine WebSocket clients
# through a full match, so they need the real Puma, the real ActionCable and
# the real SQLite database — not a stubbed transport.
module E2eServer
  DEFAULT_BOOT_TIMEOUT = 90

  class << self
    attr_reader :port, :pid, :base_url, :boot_log

    def running?
      !@pid.nil? && process_alive?(@pid)
    end

    def start!(env: "test", port: nil, boot_timeout: DEFAULT_BOOT_TIMEOUT)
      return self if running?

      @port = port || free_port
      @base_url = "http://127.0.0.1:#{@port}"
      @boot_log = Rails.root.join("tmp", "e2e-server.log").to_s

      prepare_database!(env)

      @pid = Process.spawn(
        {
          "RAILS_ENV" => env,
          "PORT" => @port.to_s,
          "SECRET_KEY_BASE" => "e2e" * 24
        },
        "bin/rails", "server", "-p", @port.to_s, "-b", "127.0.0.1",
        chdir: Rails.root.to_s,
        out: @boot_log,
        err: [:child, :out],
        pgroup: true
      )

      wait_for_boot(boot_timeout)
      self
    end

    def stop!
      return unless @pid

      begin
        Process.kill("TERM", -Process.getpgid(@pid))
      rescue Errno::ESRCH, Errno::EPERM
        nil
      end

      Timeout.timeout(15) { Process.wait(@pid) }
    rescue Errno::ECHILD, Timeout::Error
      begin
        Process.kill("KILL", -Process.getpgid(@pid))
      rescue StandardError
        nil
      end
    ensure
      @pid = nil
      @port = nil
      @base_url = nil
    end

    def log_tail(lines: 60)
      return "" unless boot_log && File.exist?(boot_log)

      File.readlines(boot_log).last(lines).join
    end

    private

    def process_alive?(pid)
      Process.kill(0, pid)
      true
    rescue Errno::ESRCH
      false
    rescue Errno::EPERM
      true
    end

    def free_port
      server = TCPServer.new("127.0.0.1", 0)
      port = server.addr[1]
      server.close
      port
    end

    def prepare_database!(env)
      system({ "RAILS_ENV" => env }, "bin/rails", "db:prepare",
             chdir: Rails.root.to_s, out: File::NULL, err: File::NULL) ||
        raise("e2e: `bin/rails db:prepare` failed for RAILS_ENV=#{env}")
    end

    def wait_for_boot(timeout)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
      while Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
        return if process_alive?(@pid) && http_ready?
        raise("e2e server exited during boot:\n#{log_tail}") unless process_alive?(@pid)

        sleep 0.25
      end
      raise("e2e server did not become ready within #{timeout}s:\n#{log_tail}")
    end

    def http_ready?
      TCPSocket.new("127.0.0.1", @port).close
      true
    rescue SystemCallError
      false
    end
  end
end
