import urllib.request, json

data = urllib.request.urlopen('https://storage.googleapis.com/trafikkort-data/geojson/wind-speeds.point.json').read()
d = json.loads(data)
print('type:', d.get('type'))
feats = d.get('features', [])
print('count:', len(feats))
if feats:
    f = feats[0]
    print('feature keys:', list(f.keys()))
    print('geometry:', f.get('geometry'))
    print('props:', f.get('properties'))
    print()
    print('--- 3 more samples ---')
    for f2 in feats[1:4]:
        print('props:', f2.get('properties'), '| geom:', f2.get('geometry'))

