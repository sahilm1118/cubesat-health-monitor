"""Read individual members of a remote ZIP over HTTP range requests (no full download)."""
import io
import sys
import time
import urllib.request
import zipfile

URL = "https://zenodo.org/api/records/15237121/files/ESA-Mission1.zip/content"


class RemoteFile(io.RawIOBase):
    def __init__(self, url, size=None):
        self.url, self.pos = url, 0
        if size is None:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req) as r:
                size = int(r.headers["Content-Length"])
        self.size = size
        self._cache = {}

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        for attempt in range(8):
            try:
                req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{self.pos + n - 1}"})
                with urllib.request.urlopen(req, timeout=300) as r:
                    data = r.read()
                break
            except Exception as e:
                time.sleep(5 * (attempt + 1))
        else:
            raise IOError("range read failed")
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b)); b[:len(data)] = data; return len(data)


def open_remote(url=URL, size=3776246073):
    return zipfile.ZipFile(io.BufferedReader(RemoteFile(url, size), buffer_size=1 << 20))


def fetch_member(z, name, url=URL, size=3776246073):
    """read one member's bytes with a single ranged request; supports stored (0) and deflate (8)"""
    import struct, zlib
    info = z.getinfo(name)
    f = RemoteFile(url, size)
    f.seek(info.header_offset)
    h = f.read(30)
    _, _, _, method, _, _, _, _, _, nlen, xlen = struct.unpack("<IHHHHHIIIHH", h)
    f.seek(info.header_offset + 30 + nlen + xlen)
    data = f.read(info.compress_size)
    if method == 0:
        return data
    if method == 8:
        return zlib.decompressobj(-15).decompress(data)
    raise NotImplementedError(f"{name}: compression method {method}")


if __name__ == "__main__":
    z = open_remote()
    infos = z.infolist()
    print(len(infos), "members")
    for i in infos[:80]:
        print(f"{i.file_size:>14,}  {i.compress_size:>14,}  {i.filename}")
    if len(infos) > 80:
        print("...")
        for i in infos[-20:]:
            print(f"{i.file_size:>14,}  {i.compress_size:>14,}  {i.filename}")
