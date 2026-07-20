import io
import unittest

from native_host.cc_batch.protocol import ProtocolError, encode_message, read_message


class ProtocolTests(unittest.TestCase):
    def test_message_round_trip_uses_length_prefixed_json(self):
        payload = {"command": "ping", "request_id": "r1"}
        framed = encode_message(payload)
        self.assertEqual(read_message(io.BytesIO(framed)), payload)

    def test_truncated_frame_is_rejected(self):
        with self.assertRaises(ProtocolError):
            read_message(io.BytesIO(b"\x04\x00\x00\x00{}"))
